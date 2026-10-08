import React, { useState, useEffect, useRef } from 'react';
import { addRecording, getPendingRecordings, getAllRecordings, appendRecordingChunk, getActiveRecordings, getRecordingChunks, clearActiveRecording, startRecordingSession, ensurePersistentStorage, pruneOrphanChunks, updateActiveRecording, DB_BLOCKED_EVENT } from '../utils/videoQueue';
import { isDesktopApp } from '../utils/desktop';
import { requestDesktopDownloadTicket, desktopDownloadFileUrl } from '../utils/desktopDownload';
import { mirrorRecordingToDisk, pruneDesktopMirror, reconcileDesktopMirror, setDesktopUploadActive } from '../utils/desktopMirror';
import { useAuth } from '../context/AuthContext';
import { runHealthCheck, HealthCheckResult, getSupportedMp4MimeType } from '../utils/healthCheck';
import { CanvasWatermarker, WatermarkSession } from '../utils/canvasWatermarker';
import { describeRecordingStats, isLaggyRecording, RecordingStats } from '../utils/watermarkOverlay';
import { getApiBaseUrl } from '../utils/apiBase';
import { normalizeScannedId, isDuplicateScan, shouldRequireFlyerId, isMeeshoMarketplace, isLikelyMeeshoShipment, isFlyerBarcode, isCourierTrackingBarcode, flyerToggleState, isKnownNonMeeshoTracking, classifyScan } from '../utils/scanFlow';
import { resolveOrderContext, OrderContext, isBlockedOrderStatus, shouldAutoRefreshOrder, ORDER_REFRESH_MS } from '../utils/orderContext';
import { isManagerOrAdminRole } from '../utils/roles';
import { VIDEO_BITRATE_BPS, MIN_RECORDING_HEIGHT, pickRecordingBitrate } from '../utils/videoQueue';
import toast from 'react-hot-toast';
import { useNavigate } from 'react-router-dom';
import { SafeImage } from '../components/ui';
import { MultiItemAlert } from '../components/MultiItemAlert';
import { WrongScanAlert, WRONG_SCAN_ALERT_MS } from '../components/WrongScanAlert';
import { MULTI_ITEM_ALERT_MS, multiItemHeadline, summarizeParcel } from '../utils/multiItem';

const CAMERA_CONSTRAINTS: MediaStreamConstraints[] = [
  // Video only — recordings carry no audio by policy (smaller files, no
  // mic permission prompts, no ambient-voice privacy issues).
  // 1080p is the recording target (AGENTS.md "Recording quality"): 1440p
  // made every packing PC encode ~1.8x the pixels in software, and many
  // webcams only deliver ~15 fps in their 2K mode — both showed up as lag.
  // `ideal` + `max` pin the mode; failing that we fall through to 720p /
  // any resolution (the 720p floor is enforced at record time).
  {
    video: { width: { ideal: 1920, max: 1920 }, height: { ideal: 1080, max: 1080 }, frameRate: { ideal: 30, max: 30 } },
    audio: false
  },
  {
    video: { width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 }, frameRate: { ideal: 30, max: 30 } },
    audio: false
  },
  {
    video: true,
    audio: false
  }
];

let sharedCameraPromise: Promise<MediaStream> | null = null;
let sharedCameraStream: MediaStream | null = null;
let cameraConsumerCount = 0;
let cameraReleaseTimer: number | null = null;

async function getCameraStream() {
  if (sharedCameraStream?.active) {
    return sharedCameraStream;
  }

  if (!sharedCameraPromise) {
    sharedCameraPromise = (async () => {
      let lastError: unknown;

      for (const constraints of CAMERA_CONSTRAINTS) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia(constraints);
          sharedCameraStream = stream;
          return stream;
        } catch (err) {
          lastError = err;
        }
      }

      throw lastError instanceof Error ? lastError : new Error('Camera is unavailable');
    })().finally(() => {
      sharedCameraPromise = null;
    });
  }

  return sharedCameraPromise;
}

function retainCameraStream() {
  cameraConsumerCount += 1;
  if (cameraReleaseTimer !== null) {
    window.clearTimeout(cameraReleaseTimer);
    cameraReleaseTimer = null;
  }
}

function releaseCameraStream() {
  cameraConsumerCount = Math.max(0, cameraConsumerCount - 1);

  cameraReleaseTimer = window.setTimeout(() => {
    if (cameraConsumerCount === 0) {
      sharedCameraStream?.getTracks().forEach(track => track.stop());
      sharedCameraStream = null;
    }
    cameraReleaseTimer = null;
  }, 1000);
}

function disposeSharedCameraStream() {
  if (cameraReleaseTimer !== null) {
    window.clearTimeout(cameraReleaseTimer);
    cameraReleaseTimer = null;
  }

  sharedCameraStream?.getTracks().forEach(track => track.stop());
  sharedCameraStream = null;
  sharedCameraPromise = null;
  cameraConsumerCount = 0;
}

// One owner per recording id: the background save holds it; crash recovery
// only takes sessions nobody holds (e.g. a remount while a save is running).
function withRecordingLock<T>(id: string, fn: () => Promise<T>, onlyIfFree = false): Promise<T | null> {
  const locks = (navigator as any).locks;
  if (!locks?.request) return fn();
  return locks.request(`vms-recording-${id}`, onlyIfFree ? { ifAvailable: true } : {}, (lock: unknown) =>
    lock ? fn() : null
  );
}

function formatClock(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

// Ticks once a second on its own, so only this text re-renders.
function RecordingTimer({ startedAt }: { startedAt: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  const seconds = startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;
  return <>{formatClock(seconds)}</>;
}

export default function PackingStation() {
  const { stationId, station, currentUser, organizationId, role, autoFlyerScan } = useAuth();
  const navigate = useNavigate();
  
  const [trackingId, setTrackingId] = useState('');
  const [scanInput, setScanInput] = useState('');
  // Meesho flyer-bag capture (per-device opt-in, persisted locally): when on,
  // each session also needs the flyer ID scanned off the bag. The ref mirrors
  // the state for async finalize closures.
  const [flyerScanEnabled, setFlyerScanEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem('pvms:flyer-scan-enabled') === '1';
    } catch {
      return false;
    }
  });
  const [flyerId, setFlyerId] = useState<string | null>(null);
  const flyerIdRef = useRef<string | null>(null);
  const [flyerWaived, setFlyerWaived] = useState(false);
  // Pre-scanned flyer: if operator scans a flyer barcode BEFORE starting a session,
  // we hold it in buffer so when they scan the AWB next, it immediately attaches!
  const [preScannedFlyerId, setPreScannedFlyerId] = useState<string | null>(null);
  const resetFlyerState = () => {
    flyerIdRef.current = null;
    setFlyerId(null);
    setFlyerWaived(false);
  };
  const toggleFlyerScan = () => {
    setFlyerScanEnabled((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('pvms:flyer-scan-enabled', next ? '1' : '0');
      } catch {
        // Private mode: toggle lasts for this session only.
      }
      return next;
    });
  };
  const [isRecording, setIsRecording] = useState(false);
  // When the current recording started (the ticking clock lives in
  // <RecordingTimer>, so the whole page no longer re-renders every second).
  const [recordingStartedAt, setRecordingStartedAt] = useState<number | null>(null);
  const [wrongScan, setWrongScan] = useState<{ code: string; reason: string; expecting: 'tracking' | 'flyer'; at: number } | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [allRecordings, setAllRecordings] = useState<any[]>([]);
  const [health, setHealth] = useState<HealthCheckResult | null>(null);
  const [cameraStatus, setCameraStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [cameraError, setCameraError] = useState('');
  const [cameraInfo, setCameraInfo] = useState<{ resolution: string; fps: number; label: string } | null>(null);
  const [cameraRestartKey, setCameraRestartKey] = useState(0);
  // Camera still starting after a few seconds is almost always the browser's
  // permission prompt waiting for a click: tell the packer where to look.
  const [cameraSlow, setCameraSlow] = useState(false);
  const [orderCtx, setOrderCtx] = useState<OrderContext | null>(null);
  const [orderResolveNonce, setOrderResolveNonce] = useState(0);
  const orderRequestRef = useRef(0);
  // Flyer mode: the scan input captures the flyer bag instead of starting a
  // new tracking session. Recording itself never waits — it starts on the
  // tracking scan as before. The parcel's synced marketplace decides it:
  // Meesho switches flyer capture ON automatically, any other marketplace
  // switches it OFF; only an unknown parcel falls back to the manual switch.
  // Context of the parcel being packed (orderCtx still holds the previous
  // parcel until the new lookup returns).
  const parcelCtx = orderCtx && orderCtx.trackingId === trackingId ? orderCtx : null;
  // Flipkart / Myntra AWBs are known non-Meesho even without order data.
  const marketplaceKnown = Boolean(parcelCtx?.marketplace) || isKnownNonMeeshoTracking(trackingId);
  const isMeeshoOrder = parcelCtx && (marketplaceKnown || parcelCtx.isMeesho)
    ? parcelCtx.isMeesho
    : isLikelyMeeshoShipment(trackingId, null);
  const flyerToggle = flyerToggleState({
    manualEnabled: flyerScanEnabled,
    hasParcel: Boolean(trackingId),
    marketplaceKnown,
    isMeesho: isMeeshoOrder,
    autoEnabled: autoFlyerScan,
  });
  const flyerMode = shouldRequireFlyerId({
    flyerScanEnabled,
    isRecording,
    flyerId,
    flyerWaived,
    // Org turned automatic flyer scan off: Meesho needs the manual switch.
    marketplaceIsMeesho: autoFlyerScan ? isMeeshoOrder : flyerScanEnabled && isMeeshoOrder,
    marketplaceKnown,
  });
  // Order lines the packer ticked as packed (by line index: one SKU can
  // sit on two lines, e.g. two Meesho sub-orders of the same SKU).
  const [verifiedSkus, setVerifiedSkus] = useState<Set<string>>(new Set());
  // Multi-item pop-up: once per scanned parcel, as soon as its lines arrive.
  const parcelSummary = summarizeParcel(parcelCtx?.items);
  const [multiAlertFor, setMultiAlertFor] = useState<string | null>(null);
  const multiAlertShownRef = useRef<string | null>(null);
  // Human station name for the burned-in watermark (never the operator
  // email). Comes from the admin-assigned default station via /api/me, so it
  // works for packers too (the old admin-stations fetch 403'd for them).
  // Falls back to the station code inside the watermarker.
  const stationName = station?.name ?? null;
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const scanInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const watermarkerRef = useRef<CanvasWatermarker | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const activeSessionStartRef = useRef<number>(0);
  const workerRef = useRef<Worker | null>(null);
  const [desktopDownloadBusy, setDesktopDownloadBusy] = useState(false);
  const stopRecordingPromiseRef = useRef<Promise<void> | null>(null);
  const resolveStopRecordingRef = useRef<(() => void) | null>(null);
  // Recorders we asked to stop; any other stop is the camera / pipeline
  // ending on its own (unplugged webcam, GPU reset) and must be surfaced.
  const requestedStopsRef = useRef(new WeakSet<MediaRecorder>());
  const pipelineErrorRef = useRef<string | null>(null);
  const transitionQueue = useRef<Promise<void>>(Promise.resolve());
  // Finished videos are saved here in the background, one at a time, so the
  // next parcel starts recording immediately.
  const finalizeQueue = useRef<Promise<void>>(Promise.resolve());
  const finalizingRef = useRef(0);
  const lastRecordingStatsRef = useRef<RecordingStats | null>(null);
  
  const STATION_ID = stationId || station?.code || 'UNKNOWN';
  const PACKER_ID = currentUser?.email || 'UNKNOWN_PACKER';
  const activeUploadRecords = allRecordings.filter(record => record.status === 'uploading');
  const activeUploadProgress = activeUploadRecords.length > 0
    ? Math.round(
        activeUploadRecords.reduce((sum, record) => {
          const progress = Number(record.uploadProgress);
          return sum + (Number.isFinite(progress) ? progress : 0);
        }, 0) / activeUploadRecords.length
      )
    : null;

  const processQueueWithFreshToken = async () => {
    if (!currentUser || !workerRef.current) return;
    const token = await currentUser.getIdToken(true);
    workerRef.current.postMessage({ type: 'PROCESS_QUEUE', payload: { token } });
  };

  // Barcode scanners type as keyboards: keep keystrokes landing in the scan
  // input even after the operator clicks buttons (focus would otherwise stay
  // on the button and the scan + trailing Enter would be lost / re-click it).
  const focusScanInput = () => {
    scanInputRef.current?.focus({ preventScroll: true });
  };

  useEffect(() => {
    const redirectToScanner = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (typing) return;
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        focusScanInput();
      }
    };
    window.addEventListener('keydown', redirectToScanner);
    return () => window.removeEventListener('keydown', redirectToScanner);
  }, []);

  // Worker Initialization
  useEffect(() => {
    workerRef.current = new Worker(new URL('../workers/videoUpload.worker.ts', import.meta.url), { type: 'module' });
    
    workerRef.current.onmessage = (e) => {
      if (e.data.type === 'UPLOAD_SUCCESS' || e.data.type === 'UPLOAD_ERROR' || e.data.type === 'UPLOAD_PROGRESS') {
        updatePendingCount();
        // Desktop app: the uploaded video's disk copy is no longer needed.
        if (e.data.type === 'UPLOAD_SUCCESS') void pruneDesktopMirror();
      } else if (e.data.type === 'AUTH_REQUIRED') {
        processQueueWithFreshToken();
      }
    };
    
    currentUser?.getIdToken().then(token => {
      workerRef.current?.postMessage({
        type: 'INIT',
        payload: {
          apiUrl: getApiBaseUrl(),
          // Use the real org UUID from /api/me, not VITE_ORG_ID (which is
          // 'default' fallback). The server's storagePath guard accepts both,
          // but per-org uploads are correct on their own merits.
          orgId: organizationId || import.meta.env.VITE_ORG_ID,
          token
        }
      });
    });

    const tokenRefreshInterval = window.setInterval(async () => {
      if (!currentUser || !workerRef.current) return;
      const token = await currentUser.getIdToken(true);
      workerRef.current.postMessage({ type: 'UPDATE_AUTH', payload: { token } });
    }, 10 * 60 * 1000);

    return () => {
      window.clearInterval(tokenRefreshInterval);
      workerRef.current?.terminate();
    };
  }, [currentUser]);

  useEffect(() => {
    watermarkerRef.current?.updateOperatorContext(STATION_ID, PACKER_ID, stationName);
  }, [STATION_ID, PACKER_ID, stationName]);

  useEffect(() => {
    if (cameraStatus !== 'loading') {
      setCameraSlow(false);
      return;
    }
    const timer = setTimeout(() => setCameraSlow(true), 4000);
    return () => clearTimeout(timer);
  }, [cameraStatus, cameraRestartKey]);

  // Order context for the scanned parcel: Order Imports mapping, then the
  // Forward Scan order copy (marketplace, SKUs, photos). Request-guarded
  // so rapid scans cannot show a stale parcel's order.
  useEffect(() => {
    setVerifiedSkus(new Set());
    if (!trackingId) {
      setOrderCtx(null);
      return;
    }
    const requestId = ++orderRequestRef.current;
    let cancelled = false;
    (async () => {
      try {
        const token = currentUser ? await currentUser.getIdToken() : null;
        const ctx = await resolveOrderContext(trackingId, getApiBaseUrl(), token);
        if (!cancelled && orderRequestRef.current === requestId) setOrderCtx(ctx);
      } catch {
        if (!cancelled && orderRequestRef.current === requestId) setOrderCtx(null);
      }
    })();
    return () => { cancelled = true; };
  }, [trackingId, currentUser, orderResolveNonce]);

  // No SKU lines yet for the parcel on screen: look again every 20 s (up to
  // ~5 min) and fill them in — with photos — the moment they exist. Separate
  // from the lookup above so the packer's ticks are never reset; works the
  // same whatever the flyer switches say.
  const [orderRefreshTick, setOrderRefreshTick] = useState(0);
  const orderRefreshTriesRef = useRef(0);
  const currentTrackingRef = useRef(trackingId);
  useEffect(() => {
    currentTrackingRef.current = trackingId;
    orderRefreshTriesRef.current = 0;
  }, [trackingId]);
  useEffect(() => {
    if (!parcelCtx || !shouldAutoRefreshOrder(parcelCtx, orderRefreshTriesRef.current)) return;
    const forTracking = parcelCtx.trackingId;
    const timer = window.setTimeout(async () => {
      orderRefreshTriesRef.current += 1;
      try {
        const token = currentUser ? await currentUser.getIdToken() : null;
        const ctx = await resolveOrderContext(forTracking, getApiBaseUrl(), token);
        if (currentTrackingRef.current !== forTracking) return;
        if (ctx.items.length > 0 || ctx.marketplace) setOrderCtx(ctx);
      } catch {
        // Offline / server busy: the next try runs on schedule.
      } finally {
        if (currentTrackingRef.current === forTracking) setOrderRefreshTick((t) => t + 1);
      }
    }, ORDER_REFRESH_MS);
    return () => window.clearTimeout(timer);
  }, [parcelCtx, currentUser, orderRefreshTick]);

  // Online/Offline status
  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      processQueueWithFreshToken();
    };
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    updatePendingCount();

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [currentUser]);

  // Never lose a tail silently: warn before closing/reloading mid-recording.
  // Chunks already written survive in IndexedDB and are recovered on return.
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => {
      // Also while a finished video is still being saved in the background.
      if (mediaRecorderRef.current || finalizingRef.current > 0) e.preventDefault();
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, []);

  // Health Check, Persistent Storage & Crash Recovery
  useEffect(() => {
    runHealthCheck().then(res => setHealth(res));

    // Survive reboot/disk-pressure: without this the browser may silently
    // evict queued videos after a shutdown (notably on Chromebooks).
    ensurePersistentStorage().then((granted) => {
      if (!granted) console.warn('Persistent browser storage not granted; upload queue may be evicted under disk pressure.');
    });

    const recoverCrashedRecordings = async () => {
      const active = await getActiveRecordings();
      if (active.length > 0) {
        for (const record of active) {
          // A save still running (remount / second tab) owns this session.
          await withRecordingLock(record.id, async () => {
          const chunks = await getRecordingChunks(record.id);
          if (chunks.length > 0) {
            // Mime recorded at session start; a wrong container label here
            // makes the recovered file unplayable.
            const blob = new Blob(chunks, { type: record.mimeType || 'video/mp4' });
            const duration = Math.floor((Date.now() - record.startTimestamp) / 1000);
            
            await addRecording({
              id: record.id,
              trackingId: record.trackingId,
              stationId: record.stationId,
              packerId: record.packerId,
              orderId: record.orderId,
              marketplace: record.marketplace,
              flyerId: record.flyerId ?? null,
              blob,
              timestamp: record.startTimestamp,
              duration
            });
            // Desktop app: mirror the recovered video to local disk as well.
            await mirrorRecordingToDisk(record.id, blob, {
              trackingId: record.trackingId,
              stationId: record.stationId,
              packerId: record.packerId,
              orderId: record.orderId ?? null,
              marketplace: record.marketplace ?? null,
              flyerId: record.flyerId ?? null,
              timestamp: record.startTimestamp,
              duration,
              mimeType: record.mimeType || 'video/mp4',
            });
          }
          await clearActiveRecording(record.id);
          }, true);
        }
        updatePendingCount();
        workerRef.current?.postMessage({ type: 'PROCESS_QUEUE', payload: {} });
      }
      // Chunks left without a session (storage cleared mid-way, old tabs).
      await pruneOrphanChunks().catch(() => 0);
    };
    const onDbBlocked = () => toast.error('Close other VMS tabs or windows: browser storage is being upgraded.', { id: 'vms-db-blocked', duration: 8000 });
    window.addEventListener(DB_BLOCKED_EVENT, onDbBlocked);
    recoverCrashedRecordings().finally(() => {
      // Desktop app: re-import any disk-mirrored videos missing from browser
      // storage, then drop disk copies of already-uploaded videos.
      void reconcileDesktopMirror();
    });
    return () => window.removeEventListener(DB_BLOCKED_EVENT, onDbBlocked);
  }, []);

  const updatePendingCount = async () => {
    const pending = await getPendingRecordings();
    setPendingCount(pending.length);
    const all = await getAllRecordings();
    setAllRecordings(all.sort((a: any, b: any) => b.timestamp - a.timestamp));
  };

  // Desktop installer: the button mints a single-use ticket (login-gated),
  // then plain navigation carries it — the server answers with the fast CDN
  // redirect, so the browser streams the file with normal progress and
  // nothing is buffered. (A bare navigation sends no login token, so opening
  // /latest directly always 401s — the ticket is the login proof.)
  const handleDesktopDownload = async (e: React.MouseEvent) => {
    e.preventDefault();
    if (desktopDownloadBusy) return;
    setDesktopDownloadBusy(true);
    try {
      const { ticket } = await requestDesktopDownloadTicket();
      window.location.href = desktopDownloadFileUrl(ticket);
      toast.success('Downloading desktop installer');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setDesktopDownloadBusy(false);
    }
  };

  // Desktop app: hold OS sleep (with heartbeat) while recording or while
  // uploads are pending, so background uploading is never suspended.
  useEffect(() => {
    setDesktopUploadActive(isRecording || pendingCount > 0);
  }, [isRecording, pendingCount]);

  const formatDuration = formatClock;

  // Wrong-scan pop-up: closes itself, or on Esc.
  useEffect(() => {
    if (!wrongScan) return;
    const timer = setTimeout(() => setWrongScan(null), WRONG_SCAN_ALERT_MS);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setWrongScan(null);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', onKey);
    };
  }, [wrongScan]);

  const generateRecordingId = () => {
    if (crypto.randomUUID) {
      return crypto.randomUUID();
    }

    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
      const value = crypto.getRandomValues
        ? crypto.getRandomValues(new Uint8Array(1))[0] & 15
        : Math.floor(Math.random() * 16);
      const hex = char === 'x' ? value : (value & 3) | 8;
      return hex.toString(16);
    });
  };

  const startRecording = async (newTrackingId: string = trackingId, initialFlyerId: string | null = null): Promise<boolean> => {
    if (!watermarkerRef.current || !health?.ready || cameraStatus !== 'ready') {
      toast.error('Camera is still loading. Please wait a moment.');
      return false;
    }
    
    // Check storage before starting
    if (navigator.storage && navigator.storage.estimate) {
      try {
        const est = await navigator.storage.estimate();
        if (est.quota !== undefined && est.usage !== undefined) {
          const free = est.quota - est.usage;
          if (free < 500 * 1024 * 1024) { // Less than 500MB
            toast.error("Browser storage is critically low (< 500MB). Wait for background uploads to finish.");
            return false;
          }
        }
      } catch(e) {}
    }
    
    const mimeType = getSupportedMp4MimeType();
    if (!mimeType) {
      toast.error("MP4 recording is not supported by this browser.");
      return false;
    }

    // Quality floor: refuse to record below 720p so blurry footage never
    // enters the evidence chain. The constraints above already prefer 1080p.
    const cameraSettings = streamRef.current?.getVideoTracks()[0]?.getSettings();
    const cameraHeight = cameraSettings?.height;
    if (typeof cameraHeight === 'number' && cameraHeight > 0 && cameraHeight < MIN_RECORDING_HEIGHT) {
      toast.error(`Camera is only ${cameraSettings?.width}x${cameraHeight} — 720p minimum required. Use a better camera or check its settings.`);
      return false;
    }

    watermarkerRef.current.updateTrackingId(newTrackingId);

    const sessionId = generateRecordingId();
    const sessionStart = Date.now();
    let chunkWriteQueue: Promise<void> = Promise.resolve();
    let chunkSeq = 0;
    activeSessionIdRef.current = sessionId;
    activeSessionStartRef.current = sessionStart;

    try {
      await startRecordingSession(sessionId, newTrackingId || 'UNKNOWN', STATION_ID, PACKER_ID, undefined, undefined, mimeType);
    } catch (err) {
      console.error('Could not open browser storage for the recording:', err);
      if (activeSessionIdRef.current === sessionId) activeSessionIdRef.current = null;
      playErrorBeep();
      toast.error(err instanceof Error ? err.message : 'Browser storage is unavailable. Close other VMS tabs and scan again.');
      return false;
    }
    if (initialFlyerId) void updateActiveRecording(sessionId, { flyerId: initialFlyerId }).catch(() => undefined);
    let chunkWriteFailed = false;

    // Recorder setup can fail (e.g. camera stream interrupted). Never leave
    // an orphan active-recording row or a stuck session id behind — the scan
    // would otherwise be lost without a trace.
    let mediaRecorder: MediaRecorder;
    let session: WatermarkSession | null = null;
    let actualWidth: number | undefined;
    let actualHeight: number | undefined;
    let actualFps: number | undefined;
    let adaptiveBps: number = VIDEO_BITRATE_BPS;
    try {
      // Watermarked camera feed for THIS parcel (see canvasWatermarker.ts).
      session = await watermarkerRef.current.startSession();
      actualWidth = session.width;
      actualHeight = session.height;
      const cameraFps = streamRef.current?.getVideoTracks()[0]?.getSettings().frameRate;
      actualFps = cameraFps ? Math.round(cameraFps) : undefined;
      // Bitrate by actual output size (single source: pickRecordingBitrate).
      adaptiveBps = actualWidth && actualHeight ? pickRecordingBitrate(actualWidth, actualHeight) : VIDEO_BITRATE_BPS;

      mediaRecorder = new MediaRecorder(session.stream, {
        mimeType,
        videoBitsPerSecond: adaptiveBps
      });
      mediaRecorder.start(2000); // Emit chunk every 2s
    } catch (err) {
      console.error('Failed to start media recorder:', err);
      void session?.stop();
      await clearActiveRecording(sessionId);
      if (activeSessionIdRef.current === sessionId) {
        activeSessionIdRef.current = null;
      }
      toast.error('Failed to start recording. Restart the camera and scan again.');
      return false;
    }

    // Each 2-second chunk is one small write (never a rewrite of the video).
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        const seq = chunkSeq++;
        chunkWriteQueue = chunkWriteQueue
          .then(() => appendRecordingChunk(sessionId, e.data, seq))
          .catch((err) => {
            console.error('Recording chunk write failed:', err);
            if (!chunkWriteFailed) {
              chunkWriteFailed = true;
              playErrorBeep();
              toast.error('Part of this video could not be saved (browser storage). Finish the parcel and check its video.', { duration: 8000 });
            }
          });
      }
    };

    mediaRecorder.onstop = () => {
      // The recorder has handed over its last chunk: release this parcel's
      // camera pipeline and let the next parcel start right away. Saving
      // the file (assemble chunks, upload queue, desktop disk copy) runs in
      // the background; a page closed mid-save is picked up by crash
      // recovery on the next load (the chunks are already on disk).
      const recordId = sessionId;
      const finishedDuration = Math.floor((Date.now() - sessionStart) / 1000);
      const finishedFlyerId = flyerIdRef.current;
      const unexpected = !requestedStopsRef.current.has(mediaRecorder);
      if (unexpected && mediaRecorderRef.current === mediaRecorder) {
        // Camera unplugged / pipeline failure: the recorder ended by itself.
        // Never leave the page saying "recording" while nothing is.
        setIsRecording(false);
        setRecordingStartedAt(null);
        playErrorBeep();
        const reason = pipelineErrorRef.current;
        pipelineErrorRef.current = null;
        toast.error(
          `Recording stopped by itself${reason ? ` (${reason})` : ''}. The video so far is saved — check the camera, then scan the parcel again.`,
          { duration: 10000 }
        );
      }
      const statsPromise: Promise<RecordingStats | null> = session ? session.stop().catch(() => null) : Promise.resolve(null);
      if (activeSessionIdRef.current === sessionId) {
        activeSessionIdRef.current = null;
      }
      if (mediaRecorderRef.current === mediaRecorder) {
        mediaRecorderRef.current = null;
      }
      resolveStopRecordingRef.current?.();
      resolveStopRecordingRef.current = null;
      stopRecordingPromiseRef.current = null;

      finalizingRef.current += 1;
      finalizeQueue.current = finalizeQueue.current
        .then(() => withRecordingLock(recordId, async () => {
          const stats = await statsPromise;
          lastRecordingStatsRef.current = stats;
          if (stats && isLaggyRecording(stats)) {
            console.warn(`[recording] ${newTrackingId}: ${describeRecordingStats(stats)}`);
          }
          await chunkWriteQueue;
          const active = await getActiveRecordings();
          const currentActive = active.find(r => r.id === recordId);
          const chunks = currentActive ? await getRecordingChunks(recordId) : [];
          if (!currentActive || chunks.length === 0) return;
          const blob = new Blob(chunks, { type: mimeType });
          const fps = stats?.cameraFps ? Math.round(stats.cameraFps) : actualFps;
          await addRecording({
            id: recordId,
            trackingId: newTrackingId || 'UNKNOWN',
            stationId: STATION_ID,
            packerId: PACKER_ID,
            orderId: currentActive.orderId,
            marketplace: currentActive.marketplace,
            flyerId: finishedFlyerId,
            width: actualWidth,
            height: actualHeight,
            fps,
            videoBitrate: adaptiveBps,
            recordingStats: stats || undefined,
            blob,
            timestamp: sessionStart,
            duration: finishedDuration
          });
          // Desktop app: every finished video is ALSO saved to local disk, so
          // it survives even if browser storage is ever evicted. Uploads still
          // run through the same queue + worker as the web app.
          await mirrorRecordingToDisk(recordId, blob, {
            trackingId: newTrackingId || 'UNKNOWN',
            stationId: STATION_ID,
            packerId: PACKER_ID,
            orderId: currentActive.orderId ?? null,
            marketplace: currentActive.marketplace ?? null,
            flyerId: finishedFlyerId,
            timestamp: sessionStart,
            duration: finishedDuration,
            mimeType,
          });

          await clearActiveRecording(recordId);
          updatePendingCount();
          processQueueWithFreshToken();
        }))
        .then(() => undefined)
        .catch((err) => console.error('Failed to save the finished recording (crash recovery will retry):', err))
        .finally(() => {
          finalizingRef.current = Math.max(0, finalizingRef.current - 1);
        });
    };

    mediaRecorderRef.current = mediaRecorder;
    setIsRecording(true);
    setRecordingStartedAt(sessionStart);
    setTrackingId(newTrackingId);
    if (initialFlyerId) {
      setFlyerId(initialFlyerId);
      flyerIdRef.current = initialFlyerId;
      setFlyerWaived(false);
      setPreScannedFlyerId(null);
    } else {
      resetFlyerState();
    }
    setScanInput(''); // Clear input
    focusScanInput(); // Ready for the next parcel immediately
    return true;
  };

  const stopRecording = () => {
    if (!mediaRecorderRef.current || mediaRecorderRef.current.state === 'inactive') {
      return Promise.resolve();
    }

    if (!stopRecordingPromiseRef.current) {
      stopRecordingPromiseRef.current = new Promise<void>((resolve) => {
        resolveStopRecordingRef.current = resolve;
      });
    }

    try {
      requestedStopsRef.current.add(mediaRecorderRef.current);
      mediaRecorderRef.current.requestData();
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    } catch (err) {
      console.error("Failed to stop recording:", err);
      resolveStopRecordingRef.current?.();
      resolveStopRecordingRef.current = null;
      stopRecordingPromiseRef.current = null;
    }

    return stopRecordingPromiseRef.current || Promise.resolve();
  };

  const playBeep = () => {
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) return;
      const ctx = new AudioContextClass();
      const osc = ctx.createOscillator();
      const gainNode = ctx.createGain();
      
      osc.type = 'sine';
      osc.frequency.setValueAtTime(800, ctx.currentTime);
      
      gainNode.gain.setValueAtTime(0.1, ctx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.1);
      
      osc.connect(gainNode);
      gainNode.connect(ctx.destination);
      
      osc.start();
      osc.stop(ctx.currentTime + 0.1);
    } catch (e) {
      console.warn("Could not play beep", e);
    }
  };

  const playFlyerBeep = () => {
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) return;
      const ctx = new AudioContextClass();
      const osc = ctx.createOscillator();
      const gainNode = ctx.createGain();
      
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(700, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(1050, ctx.currentTime + 0.12);
      
      gainNode.gain.setValueAtTime(0.12, ctx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
      
      osc.connect(gainNode);
      gainNode.connect(ctx.destination);
      
      osc.start();
      osc.stop(ctx.currentTime + 0.2);
    } catch (e) {
      console.warn("Could not play flyer beep", e);
    }
  };

  // Two rising notes: "more than one item in this parcel".
  const playMultiItemChime = () => {
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) return;
      const ctx = new AudioContextClass();
      [660, 990].forEach((frequency, i) => {
        const osc = ctx.createOscillator();
        const gainNode = ctx.createGain();
        const start = ctx.currentTime + i * 0.18;
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(frequency, start);
        gainNode.gain.setValueAtTime(0.14, start);
        gainNode.gain.exponentialRampToValueAtTime(0.001, start + 0.16);
        osc.connect(gainNode);
        gainNode.connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 0.16);
      });
    } catch (e) {
      console.warn("Could not play multi-item chime", e);
    }
  };

  const playErrorBeep = () => {
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) return;
      const ctx = new AudioContextClass();
      const osc = ctx.createOscillator();
      const gainNode = ctx.createGain();
      
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(220, ctx.currentTime);
      
      gainNode.gain.setValueAtTime(0.15, ctx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
      
      osc.connect(gainNode);
      gainNode.connect(ctx.destination);
      
      osc.start();
      osc.stop(ctx.currentTime + 0.25);
    } catch (e) {
      console.warn("Could not play error beep", e);
    }
  };

  // Multi-item parcel: pop-up with every SKU + photo + count for a few
  // seconds the moment its lines are known (wrong / short packing guard).
  const parcelTrackingId = parcelCtx?.trackingId || null;
  useEffect(() => {
    if (!parcelTrackingId || !parcelSummary.isMulti) return;
    if (multiAlertShownRef.current === parcelTrackingId) return;
    multiAlertShownRef.current = parcelTrackingId;
    setMultiAlertFor(parcelTrackingId);
    playMultiItemChime();
  }, [parcelTrackingId, parcelSummary.isMulti]);

  useEffect(() => {
    if (!multiAlertFor) return;
    const timer = setTimeout(() => setMultiAlertFor(null), MULTI_ITEM_ALERT_MS);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMultiAlertFor(null);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', onKey);
    };
  }, [multiAlertFor]);

  // Alert chime when flyerMode turns on (either at session start or when order resolves as Meesho)
  const prevFlyerModeRef = useRef(false);
  useEffect(() => {
    if (flyerMode && !prevFlyerModeRef.current) {
      playFlyerBeep();
    }
    prevFlyerModeRef.current = flyerMode;
  }, [flyerMode]);

  // Scan success chirp (recording started, next parcel ready).

  // A missing order is NOT an error: the parcel may simply predate the order
  // sync. Recording proceeds regardless, and details attach when found
  // (Retry button, later scans, or the upload worker enriching at upload).
  const isResolvingOrder = Boolean(trackingId && !parcelCtx);

  const handleBarcodeScan = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      const scannedCode = normalizeScannedId(scanInput);
      setScanInput(''); // Immediately clear input for rapid scanning
      if (!scannedCode) return;

      // Garment-tag QR, product sticker, ".01"...: never a parcel. Warn and
      // change nothing (no recording started, stopped or flyer linked).
      const verdict = classifyScan(scannedCode);
      if (verdict.kind === 'invalid') {
        playErrorBeep();
        setWrongScan({ code: verdict.code, reason: verdict.reason, expecting: flyerMode ? 'flyer' : 'tracking', at: Date.now() });
        focusScanInput();
        return;
      }
      setWrongScan(null);

      const isFlyer = isFlyerBarcode(scannedCode);
      const isTracking = isCourierTrackingBarcode(scannedCode);

      // --- FLYER MODE: Currently recording a parcel and awaiting its flyer bag barcode ---
      if (flyerMode) {
        // Re-scanning current tracking ID?
        if (scannedCode === trackingId) {
          playErrorBeep();
          toast.error(`Already recording ${trackingId}. Please scan the Meesho Flyer bag (TP...) or click 'Skip flyer'.`);
          focusScanInput();
          return;
        }

        // If operator scanned another courier tracking number (e.g. VL..., SF..., numeric AWB):
        // They moved to the NEXT parcel without a flyer!
        // Finalize current parcel cleanly without flyer, and start next parcel.
        if (isTracking && scannedCode !== trackingId) {
          toast(`Previous parcel saved without flyer. Started next parcel ${scannedCode}`);
          setFlyerWaived(true);
          playBeep();

          transitionQueue.current = transitionQueue.current.then(async () => {
            try {
              if (activeSessionIdRef.current) {
                await stopRecording();
              }
              await startRecording(scannedCode);
            } catch (err) {
              console.error("Recording transition error:", err);
            }
          });
          return;
        }

        // Accept as flyer ID:
        setFlyerId(scannedCode);
        flyerIdRef.current = scannedCode;
        if (activeSessionIdRef.current) {
          void updateActiveRecording(activeSessionIdRef.current, { flyerId: scannedCode }).catch(() => undefined);
        }
        playFlyerBeep();
        // Saved with this parcel's video; Meesho link-up is a separate (admin) switch.
        toast.success(`Flyer saved with this parcel: ${scannedCode}`);
        focusScanInput();
        return;
      }

      // --- TRACKING SCAN MODE: Expecting parcel AWB to start recording ---

      // What if operator scanned a Flyer bag barcode FIRST (e.g. TP4OOEU...)?
      if (isFlyer) {
        setPreScannedFlyerId(scannedCode);
        playFlyerBeep();
        toast.success(`Flyer packet ${scannedCode} ready! Now scan parcel shipping label (AWB) to record.`);
        focusScanInput();
        return;
      }

      // Normal tracking scan
      playBeep();

      transitionQueue.current = transitionQueue.current.then(async () => {
        try {
          if (activeSessionIdRef.current) {
            // Scanner double-read of the parcel already being recorded:
            // keep the single session instead of splitting its video in two.
            const active = await getActiveRecordings();
            const currentActive = active.find(r => r.id === activeSessionIdRef.current);
            if (currentActive && isDuplicateScan(currentActive.trackingId, scannedCode)) {
              toast('Already recording this tracking ID');
              focusScanInput();
              return;
            }
            await stopRecording();
          }
          await startRecording(scannedCode, preScannedFlyerId);
        } catch (err) {
          console.error("Recording transition error:", err);
        }
      });
    }
  };

  const handleRestartStation = async () => {
    if (isRecording && !window.confirm('Stop the current recording and restart the packing station camera?')) {
      return;
    }

    try {
      await stopRecording();
      streamRef.current = null;
      setTrackingId('');
      setScanInput('');
      setCameraInfo(null);
      setCameraStatus('loading');
      setCameraError('');
      disposeSharedCameraStream();
      setCameraRestartKey(key => key + 1);
      toast.success('Station camera restarted');
      focusScanInput();
    } catch (err) {
      console.error('Failed to restart station', err);
      toast.error('Failed to restart station');
    }
  };

  const handleReportIssue = async () => {
    const storageEstimate = navigator.storage?.estimate
      ? await navigator.storage.estimate().catch(() => null)
      : null;

    const report = {
      generatedAt: new Date().toISOString(),
      stationId: STATION_ID,
      packerId: PACKER_ID,
      trackingId: trackingId || null,
      isRecording,
      durationSeconds: isRecording && recordingStartedAt ? Math.floor((Date.now() - recordingStartedAt) / 1000) : 0,
      lastRecording: lastRecordingStatsRef.current,
      cameraStatus,
      cameraError: cameraError || null,
      cameraInfo,
      networkOnline: isOnline,
      pendingUploads: pendingCount,
      activeUploadProgress,
      health,
      storageEstimate
    };

    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `packing-issue-${Date.now()}.json`;
    a.click();
    window.URL.revokeObjectURL(url);
    toast.success('Issue report downloaded');
  };

  // Camera Setup
  useEffect(() => {
    let cancelled = false;
    retainCameraStream();
    setCameraStatus('loading');
    setCameraError('');

    if (navigator.mediaDevices) {
      getCameraStream()
        .then(stream => {
          if (cancelled) return;

          streamRef.current = stream;
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
            videoRef.current.play().catch(() => {
              setCameraStatus('error');
              setCameraError('Camera preview could not start. Allow camera access and reload the page.');
            });
          }
          
          const watermarker = new CanvasWatermarker(stream, STATION_ID, 'IDLE', PACKER_ID);
          watermarker.onPipelineError = (message) => {
            pipelineErrorRef.current = message;
          };
          watermarker.prewarm();
          watermarkerRef.current = watermarker;

          const track = stream.getVideoTracks()[0];
          track.addEventListener('ended', () => {
            if (cancelled) return;
            setCameraStatus('error');
            setCameraError('The camera was disconnected. Plug it back in and press Restart station.');
          });
          const settings = track.getSettings();
          setCameraInfo({
            resolution: `${settings.width} x ${settings.height}`,
            fps: Math.round(settings.frameRate || 0),
            label: track.label || 'Unknown Camera'
          });
          setCameraStatus('ready');
        })
        .catch(err => {
          if (cancelled) return;

          console.error("Error accessing camera:", err);
          setCameraStatus('error');
          setCameraError(err instanceof Error ? err.message : 'Camera permission was denied or the camera is unavailable.');
        });
    } else {
      setCameraStatus('error');
      setCameraError('This browser does not support camera access.');
    }
    
    return () => {
      cancelled = true;
      streamRef.current = null;
      // Leaving the page mid-recording: stop (and save) it, so the camera
      // clone and recorder do not keep running in the background.
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== 'inactive') {
        requestedStopsRef.current.add(recorder);
        try { recorder.requestData(); recorder.stop(); } catch { /* already stopping */ }
      }
      const watermarker = watermarkerRef.current;
      watermarkerRef.current = null;
      void finalizeQueue.current.finally(() => watermarker?.dispose());
      releaseCameraStream();
    };
  }, [cameraRestartKey]);

  if (health && !health.ready) {
      return (
        <div className="flex-1 flex items-center justify-center bg-surface-bg min-h-screen">
          <div className="bg-surface-card p-8 rounded-xl border border-critical/20 max-w-md w-full shadow-lg">
            <h2 className="text-2xl font-bold text-critical mb-4 flex items-center gap-2">
              <span className="material-symbols-outlined">error</span>
              Packing Station Not Ready
            </h2>
            <div className="space-y-3 mb-6">
              <div className="flex justify-between items-center border-b border-border-subtle pb-2">
                <span className="font-metadata text-on-surface-variant">Camera</span>
                <span className={health.camera ? "text-success" : "text-critical"}>{health.camera ? "Ready" : "Missing"}</span>
              </div>
              <div className="flex justify-between items-center border-b border-border-subtle pb-2">
                <span className="font-metadata text-on-surface-variant">MP4 Recording</span>
                <span className={health.mp4 ? "text-success" : "text-critical"}>{health.mp4 ? "Ready" : "Unsupported"}</span>
              </div>
              <div className="flex justify-between items-center border-b border-border-subtle pb-2">
                <span className="font-metadata text-on-surface-variant">Browser Storage</span>
                <span className={health.storage ? "text-success" : "text-critical"}>{health.storage ? "Ready" : "Missing"}</span>
              </div>
            </div>
            {!health.mp4 && (
              <p className="text-body-sm text-on-surface-variant bg-critical/5 p-4 rounded-lg">
                MP4 recording is not supported by this browser.<br/><br/>
                Please use a supported current version of Microsoft Edge or Google Chrome on this workstation.
              </p>
            )}
          </div>
        </div>
      );
  }

  return (
    <div className="flex-1 flex flex-col min-h-screen relative bg-surface-bg">
      {wrongScan && (
        <WrongScanAlert
          key={wrongScan.at}
          code={wrongScan.code}
          reason={wrongScan.reason}
          expecting={wrongScan.expecting}
          onClose={() => {
            setWrongScan(null);
            focusScanInput();
          }}
        />
      )}
      {multiAlertFor && multiAlertFor === trackingId && parcelSummary.isMulti && (
        <MultiItemAlert
          summary={parcelSummary}
          trackingId={trackingId}
          durationMs={MULTI_ITEM_ALERT_MS}
          onClose={() => {
            setMultiAlertFor(null);
            focusScanInput();
          }}
        />
      )}
      {/* TopNavBar */}
      <header className="bg-surface-container-lowest flex flex-col lg:flex-row lg:justify-between lg:items-center gap-3 px-gutter py-3 min-h-[64px] border-b border-border-subtle shrink-0">
        <div className="flex flex-col xl:flex-row xl:items-center gap-3 xl:gap-6 min-w-0">
          {STATION_ID === 'UNKNOWN' ? (
            <div className="flex items-center gap-2 min-w-0">
              <h2 className="font-headline-1 text-headline-1 text-on-background">Packing Station</h2>
              <span
                className="px-2.5 py-1 rounded-full text-[11px] font-bold uppercase tracking-wide bg-warning/10 text-warning border border-warning/30"
                title="Ask an admin to link this login to a packing station (Users page). Videos still record and upload."
              >
                No station assigned
              </span>
            </div>
          ) : (
            <div className="min-w-0">
              <h2 className="font-headline-1 text-headline-1 text-on-background truncate" title={STATION_ID}>
                {stationName || STATION_ID}
              </h2>
              {stationName && stationName !== STATION_ID && (
                <p className="font-metadata text-metadata text-on-surface-variant">Station {STATION_ID}</p>
              )}
            </div>
          )}
          {/* Status Chips */}
          <div className="flex flex-wrap items-center gap-3">
            <div className={`flex items-center gap-2 px-3 py-1 rounded-full border ${
              cameraStatus === 'ready'
                ? 'bg-success/10 border-success/20'
                : cameraStatus === 'error'
                  ? 'bg-critical/10 border-critical/20'
                  : 'bg-warning/10 border-warning/20'
            }`}>
              <div className={`w-2 h-2 rounded-full ${
                cameraStatus === 'ready'
                  ? 'bg-success'
                  : cameraStatus === 'error'
                    ? 'bg-critical'
                    : 'bg-warning animate-pulse'
              }`}></div>
              <span className={`font-metadata text-metadata ${
                cameraStatus === 'ready'
                  ? 'text-success'
                  : cameraStatus === 'error'
                    ? 'text-critical'
                    : 'text-warning'
              }`}>
                {cameraStatus === 'ready' ? 'Camera Online' : cameraStatus === 'error' ? 'Camera Error' : 'Camera Starting'}
              </span>
            </div>
            <div className={`flex items-center gap-2 px-3 py-1 rounded-full border ${isOnline ? 'bg-success/10 border-success/20' : 'bg-critical/10 border-critical/20'}`}>
              <div className={`w-2 h-2 rounded-full ${isOnline ? 'bg-success' : 'bg-critical'}`}></div>
              <span className={`font-metadata text-metadata ${isOnline ? 'text-success' : 'text-critical'}`}>{isOnline ? 'Network Online' : 'Network Offline'}</span>
            </div>
            {pendingCount > 0 && (
              <div className="flex items-center gap-2 px-3 py-1 bg-warning/10 rounded-full border border-warning/20">
                <div className="w-2 h-2 rounded-full bg-warning animate-pulse"></div>
                <span className="font-metadata text-metadata text-warning">
                  {pendingCount} Upload{pendingCount !== 1 ? 's' : ''} Pending
                  {activeUploadProgress !== null ? ` - ${activeUploadProgress}%` : ''}
                </span>
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-4 self-end lg:self-auto">
          {!isDesktopApp() && (
            <button
              type="button"
              onClick={handleDesktopDownload}
              disabled={desktopDownloadBusy}
              title="Install the PVMS Packing desktop app — videos save to this PC and keep uploading in the background"
              className="flex items-center gap-1.5 font-body-sm text-body-sm text-primary hover:opacity-80 transition-opacity disabled:opacity-40 disabled:cursor-wait"
            >
              <span className={`material-symbols-outlined text-body-sm ${desktopDownloadBusy ? 'animate-spin' : ''}`}>
                {desktopDownloadBusy ? 'progress_activity' : 'download'}
              </span>
              <span className="hidden md:inline">{desktopDownloadBusy ? 'Preparing…' : 'Desktop App'}</span>
            </button>
          )}
          {isManagerOrAdminRole(role) ? (
            <>
              <div className="h-6 w-px bg-border-subtle mx-2"></div>
              <button
                type="button"
                title="System health"
                aria-label="System health"
                onClick={() => navigate('/system-health')}
                className="text-on-surface-variant hover:text-primary transition-colors"
              >
                <span className="material-symbols-outlined">notifications</span>
              </button>
              <button
                type="button"
                title="Admin settings"
                aria-label="Admin settings"
                onClick={() => navigate('/settings')}
                className="text-on-surface-variant hover:text-primary transition-colors"
              >
                <span className="material-symbols-outlined">account_circle</span>
              </button>
            </>
          ) : (
            currentUser?.email && (
              <span className="hidden md:inline font-metadata text-metadata text-on-surface-variant truncate max-w-[220px]" title={`Signed in as ${currentUser.email}`}>
                {currentUser.email}
              </span>
            )
          )}
        </div>
      </header>

      {/* Operational Workspace */}
      <main className="flex-1 p-gutter flex flex-col xl:flex-row gap-gutter overflow-y-auto xl:overflow-hidden xl:h-[calc(100vh-64px)]">
        {/* Left Side: Live Feed & Actions (70%) */}
        <div className="w-full xl:w-[70%] flex flex-col gap-gutter">
          
          {/* Camera Viewfinder */}
          <div className="relative w-full aspect-video bg-black rounded-lg border border-border-subtle overflow-hidden shadow-sm flex flex-col justify-between">
            {/* Display Video element natively */}
            <video 
              ref={videoRef} 
              autoPlay 
              playsInline 
              muted 
              className="absolute inset-0 w-full h-full object-contain"
            />

            {cameraStatus !== 'ready' && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/80 text-white text-center px-6">
                {cameraStatus === 'loading' ? (
                  <span role="status" aria-label="Starting camera" className="inline-block w-10 h-10 rounded-full border-4 border-white/80 border-t-transparent animate-spin" />
                ) : (
                  <span className="material-symbols-outlined text-4xl">videocam_off</span>
                )}
                <p className="font-body-sm text-body-sm">
                  {cameraStatus === 'loading' ? 'Starting camera...' : cameraError || 'Camera unavailable'}
                </p>
                {cameraStatus === 'loading' && cameraSlow && (
                  <p className="font-body-sm text-body-sm text-amber-300 max-w-sm">
                    Waiting for camera permission — click <strong>Allow</strong> in the browser prompt at the top-left of the window.
                  </p>
                )}
              </div>
            )}
            
            {/* Crosshairs / Grid */}
            <div className="absolute inset-0 grid grid-cols-3 grid-rows-3 pointer-events-none opacity-30">
              <div className="border-r border-b border-white"></div>
              <div className="border-r border-b border-white"></div>
              <div className="border-b border-white"></div>
              <div className="border-r border-b border-white"></div>
              <div className="border-r border-b border-white"></div>
              <div className="border-b border-white"></div>
              <div className="border-r border-white"></div>
              <div className="border-r border-white"></div>
              <div></div>
            </div>
          </div>

          {/* Action Bar */}
          <div className={`rounded-xl border p-5 shadow-lg transition-all duration-300 flex flex-col 2xl:flex-row 2xl:items-center gap-6 ${
            flyerMode
              ? 'bg-amber-950/20 border-2 border-amber-500 shadow-[0_0_30px_rgba(245,158,11,0.25)] ring-1 ring-amber-500/50'
              : preScannedFlyerId
                ? 'bg-emerald-950/20 border-2 border-emerald-500/70 shadow-[0_0_20px_rgba(16,185,129,0.2)] ring-1 ring-emerald-500/40'
                : 'bg-surface-card border-border-subtle'
          }`}>
            <div className="flex-1">
              <div className="flex items-center justify-between gap-3 mb-2.5">
                <div className="flex items-center gap-2">
                  {flyerMode ? (
                    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-bold uppercase tracking-wider bg-amber-500 text-amber-950 animate-pulse">
                      <span className="material-symbols-outlined text-sm font-bold">local_mall</span>
                      {isMeeshoOrder && flyerToggle.auto ? (
                        <>STEP 2: SCAN MEESHO FLYER BAG (TP...) &bull; AUTO-ACTIVATED (MEESHO)</>
                      ) : (
                        <>STEP 2: SCAN MEESHO FLYER BAG (TP...)</>
                      )}
                    </span>
                  ) : preScannedFlyerId ? (
                    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-bold uppercase tracking-wider bg-emerald-500 text-emerald-950">
                      <span className="material-symbols-outlined text-sm font-bold">check_circle</span>
                      FLYER QUEUED: {preScannedFlyerId} &bull; SCAN AWB TO START
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-bold uppercase tracking-wider bg-surface-container-high text-on-surface-variant border border-outline-variant">
                      <span className="material-symbols-outlined text-sm">barcode_scanner</span>
                      STEP 1: SCAN COURIER AWB / TRACKING ID
                    </span>
                  )}
                </div>

                <span
                  className="flex items-center gap-2"
                  title={flyerToggle.auto
                    ? 'Automatic: Meesho parcels ask for the flyer bag by themselves; other marketplaces skip it'
                    : autoFlyerScan
                      ? 'Order marketplace unknown: switch ON to capture a flyer bag for this parcel'
                      : 'Automatic flyer scan is off for this organization (Meesho Flyer page): use this switch'}
                >
                  {flyerToggle.auto && (
                    <span className={`px-2 py-0.5 rounded text-[11px] font-bold border ${flyerToggle.on
                      ? `bg-amber-500/15 text-amber-800 border-amber-500/40 ${trackingId ? 'animate-pulse' : ''}`
                      : 'bg-surface-container-high text-on-surface-variant border-outline-variant'}`}
                    >
                      Auto · {!trackingId ? 'Meesho orders' : flyerToggle.on ? 'Meesho' : (parcelCtx?.marketplace || 'not Meesho')}
                    </span>
                  )}
                  <span className="font-metadata text-metadata text-on-surface-variant uppercase tracking-wider">Flyer scan</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={flyerToggle.on}
                    aria-label={flyerToggle.auto ? 'Flyer ID scanning (set automatically from the order marketplace)' : 'Toggle flyer ID scanning'}
                    onClick={toggleFlyerScan}
                    disabled={flyerToggle.auto}
                    className={`relative w-9 h-5 rounded-full transition-colors shrink-0 disabled:cursor-not-allowed ${flyerToggle.on ? 'bg-amber-500' : 'bg-surface-container-high border border-outline-variant'}`}
                  >
                    <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${flyerToggle.on ? 'left-[18px]' : 'left-0.5'}`} />
                  </button>
                </span>
              </div>

              <div className="relative">
                <input 
                  className={`w-full rounded-lg p-4 font-technical text-headline-1 transition-all duration-200 focus:outline-none ${
                    flyerMode
                      ? 'bg-amber-950/40 border-2 border-amber-400 text-amber-100 placeholder:text-amber-300/60 focus:ring-4 focus:ring-amber-500/40'
                      : preScannedFlyerId
                        ? 'bg-emerald-950/30 border-2 border-emerald-400 text-emerald-100 placeholder:text-emerald-300/60 focus:ring-4 focus:ring-emerald-500/40'
                        : 'bg-surface-container border border-outline-variant text-on-surface placeholder:text-on-surface-variant/40 focus:ring-2 focus:ring-primary'
                  }`}
                  placeholder={
                    flyerMode 
                      ? '🏷️ SCAN MEESHO FLYER BAG (e.g. TP400...) NOW...' 
                      : preScannedFlyerId 
                        ? '📦 SCAN PARCEL AWB / SHIPPING LABEL TO START RECORDING...' 
                        : 'Scan parcel to start recording...'
                  }
                  type="text" 
                  autoFocus 
                  ref={scanInputRef}
                  value={scanInput}
                  onChange={(e) => setScanInput(e.target.value)}
                  onKeyDown={handleBarcodeScan}
                />
                <span className={`material-symbols-outlined absolute right-4 top-4 ${
                  flyerMode ? 'text-amber-400 animate-bounce' : 'text-on-surface-variant animate-pulse'
                }`}>
                  {flyerMode ? 'local_mall' : 'barcode_scanner'}
                </span>
              </div>

              {flyerMode && (
                <div className="mt-2.5 flex items-center justify-between gap-2 p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30">
                  <p className="font-body-sm text-body-sm text-amber-300 font-medium flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-sm">info</span>
                    Recording parcel <span className="font-technical text-white font-bold">{trackingId}</span> &mdash; scan the Meesho flyer packet barcode (starts with TP...)
                  </p>
                  <button
                    type="button"
                    onClick={() => { setFlyerWaived(true); focusScanInput(); }}
                    className="font-body-sm text-body-sm text-amber-400 hover:text-white px-2.5 py-1 rounded bg-amber-950/60 hover:bg-amber-900 border border-amber-500/50 transition-colors shrink-0"
                  >
                    Skip flyer
                  </button>
                </div>
              )}

              {preScannedFlyerId && !flyerMode && (
                <div className="mt-2.5 flex items-center justify-between gap-2 p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30">
                  <p className="font-body-sm text-body-sm text-emerald-300 font-medium flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-sm">check_circle</span>
                    Flyer <span className="font-technical text-white font-bold">{preScannedFlyerId}</span> queued &mdash; scan the parcel shipping label (AWB) now to pair them.
                  </p>
                  <button
                    type="button"
                    onClick={() => { setPreScannedFlyerId(null); focusScanInput(); }}
                    className="font-body-sm text-body-sm text-emerald-400 hover:text-white px-2.5 py-1 rounded bg-emerald-950/60 hover:bg-emerald-900 border border-emerald-500/50 transition-colors shrink-0"
                  >
                    Clear
                  </button>
                </div>
              )}
            </div>
            <div className="flex flex-col gap-2 shrink-0 w-full 2xl:w-auto">
              {/* Recording starts automatically on scan — only Stop is needed. */}
              <button
                onClick={() => { stopRecording(); setTrackingId(''); setScanInput(''); focusScanInput(); }}
                disabled={!isRecording}
                className="flex items-center justify-center gap-2 bg-critical text-on-error px-6 py-3 rounded-lg font-medium hover:opacity-90 transition-opacity shadow-sm min-w-[140px] disabled:opacity-40 disabled:cursor-not-allowed">
                <span className="material-symbols-outlined text-body-sm">stop_circle</span>Stop
              </button>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={handleRestartStation}
                  className="flex-1 flex items-center justify-center gap-2 bg-surface-container-low hover:bg-surface-container-high py-2 rounded-lg text-body-sm text-primary transition-colors border border-primary/20"
                >
                  <span className="material-symbols-outlined text-body-sm">restart_alt</span>Restart
                </button>
                <button
                  type="button"
                  onClick={handleReportIssue}
                  className="flex-1 flex items-center justify-center gap-2 bg-surface-container-low hover:bg-surface-container-high py-2 rounded-lg text-body-sm text-on-surface-variant transition-colors border border-outline-variant"
                >
                  <span className="material-symbols-outlined text-body-sm">report_problem</span>Report Issue
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Right Side: Scan Panel (30%) */}
        <div className="w-full xl:w-[30%] min-h-[360px] flex flex-col gap-gutter overflow-y-auto pr-2 pb-2">
          {/* Current Session Details (compact) */}
          <div className="bg-surface-card rounded-lg border border-border-subtle p-4 shadow-sm flex flex-col gap-3">
            <div className="flex justify-between items-center border-b border-border-subtle pb-2.5">
              <h3 className="font-headline-2 text-headline-2 text-on-surface">Current Session</h3>
              {isRecording ? (
                <span className="px-2.5 py-0.5 bg-critical/10 text-critical rounded-full font-metadata text-metadata border border-critical/20 flex items-center gap-1.5">
                  <div className="w-1.5 h-1.5 rounded-full bg-critical animate-pulse"></div>
                  Recording
                </span>
              ) : (
                <span className="px-2.5 py-0.5 bg-surface-variant text-on-surface-variant rounded-full font-metadata text-metadata border border-outline-variant flex items-center gap-1.5">
                  <div className="w-1.5 h-1.5 rounded-full bg-outline-variant"></div>
                  Standby
                </span>
              )}
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <p className="font-metadata text-metadata text-on-surface-variant uppercase tracking-wider shrink-0">Tracking</p>
              <p className="font-technical text-body-lg font-semibold text-on-surface truncate" title={trackingId || 'N/A'}>{trackingId || "N/A"}</p>
            </div>
            {flyerToggle.on && (isRecording || trackingId) && (
              <div className="flex items-baseline justify-between gap-2">
                <p className="font-metadata text-metadata text-on-surface-variant uppercase tracking-wider shrink-0">Flyer</p>
                <p className="font-technical text-body-lg font-semibold truncate" title={flyerId || ''}>
                  {flyerId
                    ? <span className="text-success">{flyerId}</span>
                    : flyerMode
                      ? <span className="text-warning">Awaiting scan…</span>
                      : <span className="text-on-surface-variant">—</span>}
                </p>
              </div>
            )}
            <div className="flex items-center justify-between gap-2 font-technical text-body-sm text-on-surface-variant">
              <span title="Start time">{isRecording && recordingStartedAt ? new Date(recordingStartedAt).toLocaleTimeString('en-US', { hour12: false }) : "--:--:--"}</span>
              <span title="Duration" className="text-on-surface font-medium"><RecordingTimer startedAt={isRecording ? recordingStartedAt : null} /></span>
              {cameraInfo && (
                <span className="truncate" title={`${cameraInfo.label} • ${cameraInfo.resolution} • ${cameraInfo.fps} FPS`}>
                  {cameraInfo.resolution} • {cameraInfo.fps}fps
                </span>
              )}
            </div>
          </div>

          {/* Order Details: marketplace, SKUs and photos from the Forward Scan copy */}
          <div className="bg-surface-card rounded-lg border border-border-subtle p-card-padding shadow-sm flex flex-col gap-4">
            <div className="flex justify-between items-center border-b border-border-subtle pb-3">
              <h3 className="font-headline-2 text-headline-2 text-on-surface">Order Details</h3>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setOrderResolveNonce((n) => n + 1)}
                  disabled={!trackingId}
                  title="Retry order lookup"
                  className="flex items-center gap-1 font-body-sm text-body-sm text-primary hover:opacity-80 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <span className="material-symbols-outlined text-body-sm">refresh</span>
                  Retry
                </button>
                {parcelCtx?.marketplace ? (
                  <span
                    title={parcelCtx.channel || parcelCtx.marketplace}
                    className={`px-2 py-1 rounded text-[11px] font-bold tracking-wide border ${parcelCtx.isMeesho
                      ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                      : 'bg-primary/10 text-primary border-primary/20'}`}
                  >
                    {parcelCtx.marketplace.toUpperCase()}
                  </span>
                ) : (
                  <span className="px-2 py-1 rounded text-[11px] font-bold tracking-wide border bg-surface-variant text-on-surface-variant border-outline-variant">
                    UNASSIGNED
                  </span>
                )}
                {parcelCtx?.status && (
                  <span className={`px-2 py-1 rounded text-[11px] font-bold tracking-wide border ${isBlockedOrderStatus(parcelCtx.statusGroup)
                    ? 'bg-critical/10 text-critical border-critical/30'
                    : 'bg-surface-variant text-on-surface-variant border-outline-variant'}`}
                  >
                    {parcelCtx.status}
                  </span>
                )}
              </div>
            </div>
            {isResolvingOrder ? (
              <div className="flex flex-col gap-4" aria-busy="true" aria-live="polite">
                <div>
                  <div className="h-3 w-20 rounded bg-surface-variant animate-pulse mb-2" />
                  <div className="h-5 w-2/3 rounded bg-surface-container-low animate-pulse" />
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="rounded-lg border border-border-subtle bg-surface-bg overflow-hidden">
                      <div className="aspect-square bg-surface-container-low animate-pulse" />
                      <div className="p-1.5 flex flex-col gap-1.5">
                        <div className="h-3 w-4/5 rounded bg-surface-variant animate-pulse" />
                        <div className="h-2.5 w-3/5 rounded bg-surface-container-low animate-pulse" />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <>
                {isBlockedOrderStatus(parcelCtx?.statusGroup) && (
                  <div className="rounded-lg p-3 font-body-sm text-body-sm flex items-center gap-2 border bg-critical/10 border-critical/30 text-critical" role="alert">
                    <span className="material-symbols-outlined text-body-sm">block</span>
                    {parcelCtx?.statusGroup === 'PARTIAL_CANCEL'
                      ? 'Part of this order is cancelled in OMS — check the items before sealing.'
                      : `This order is ${parcelCtx?.statusGroup === 'RETURN' ? 'a return' : 'cancelled'} in OMS — set the parcel aside.`}
                  </div>
                )}
                <div>
                  <p className="font-metadata text-metadata text-on-surface-variant mb-1 uppercase tracking-wider">Order ID</p>
                  <p className="font-technical text-body-lg text-on-surface">{parcelCtx?.orderId || 'Not mapped yet'}</p>
                  {/ajio/i.test(parcelCtx?.marketplace || '') && (
                    <p className="font-metadata text-metadata text-on-surface-variant mt-1">
                      Ajio: the video is renamed only by the Order Imports upload (FN…/EX… order number).
                    </p>
                  )}
                </div>
                {parcelCtx && parcelCtx.items.length > 0 ? (
                  <>
                    {(() => {
                      const { units, isMulti } = parcelSummary;
                      const verifiedCount = parcelCtx.items.filter((_, index) => verifiedSkus.has(String(index))).length;
                      const allVerified = verifiedCount === parcelCtx.items.length;
                      return (
                        <>
                          {isMulti && (
                            <div className={`rounded-lg p-3 font-body-sm text-body-sm flex items-center gap-2 border ${allVerified ? 'bg-success/10 border-success/30 text-success' : 'bg-warning/10 border-warning/30 text-warning'}`}>
                              <span className="material-symbols-outlined text-body-sm">warning</span>
                              {allVerified
                                ? `All ${units} items verified — ready to seal.`
                                : `MULTI-ITEM: ${multiItemHeadline(parcelSummary)} — tap each item as you pack it.`}
                            </div>
                          )}
                          <div className="grid grid-cols-3 gap-2">
                            {parcelCtx.items.map((item, index) => {
                              const lineKey = String(index);
                              const verified = verifiedSkus.has(lineKey);
                              return (
                                <button
                                  key={`${index}-${item.sku}`}
                                  type="button"
                                  onClick={() => {
                                    setVerifiedSkus((prev) => {
                                      const next = new Set(prev);
                                      if (next.has(lineKey)) next.delete(lineKey);
                                      else next.add(lineKey);
                                      return next;
                                    });
                                  }}
                                  title={verified ? 'Tap to unmark' : 'Tap when packed'}
                                  className={`rounded-lg border bg-surface-bg overflow-hidden text-left transition-all ${verified ? 'border-success/50 ring-1 ring-success/40' : 'border-border-subtle hover:border-primary/40'}`}
                                >
                                  <div className="aspect-square flex items-center justify-center bg-surface-container overflow-hidden relative">
                                    {item.imageUrl ? (
                                      <SafeImage
                                        src={item.imageUrl}
                                        alt={item.title || item.sku}
                                        fallbackIcon="package_2"
                                        className="absolute inset-0 w-full h-full text-2xl text-on-surface-variant/50"
                                      />
                                    ) : (
                                      <span className="material-symbols-outlined text-2xl text-on-surface-variant/50">package_2</span>
                                    )}
                                    {verified && (
                                      <span className="absolute top-1 right-1 w-5 h-5 rounded-full bg-success text-white flex items-center justify-center">
                                        <span className="material-symbols-outlined text-[14px]">check</span>
                                      </span>
                                    )}
                                    <span className={`absolute bottom-1 right-1 px-1.5 py-0.5 rounded font-metadata ${item.quantity > 1 ? 'bg-warning text-black text-body-sm font-black' : 'bg-black/60 text-white text-metadata'}`}>
                                      x{item.quantity}
                                    </span>
                                  </div>
                                  <div className="p-1.5">
                                    <p className="font-technical text-[11px] text-on-surface truncate" title={item.title || item.sku}>{item.title || item.sku}</p>
                                     <p className="font-metadata text-metadata text-on-surface-variant truncate" title={item.subOrderId || item.channelOrderId || item.sku}>
                                       {item.subOrderId || item.channelOrderId || item.sku}
                                    </p>
                                    {item.imageMatch === 'style' && (
                                      <p className="font-metadata text-[10px] text-amber-800 truncate" title="No photo for this exact SKU yet">Photo: other size</p>
                                    )}
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        </>
                      );
                    })()}
                  </>
                ) : (
                  <p className="font-body-sm text-body-sm text-on-surface-variant bg-surface-container-low rounded-lg p-3">
                    {trackingId
                      ? 'No SKU lines for this parcel yet — checking again automatically; they appear here (with photos) as soon as the order reaches VMS. A manager can also add them under Synced Orders.'
                      : 'Scan a parcel to see its order.'}
                  </p>
                )}
              </>
            )}
          </div>

          {/* Recent Recordings */}
          <div className="bg-surface-card rounded-lg border border-border-subtle shadow-sm flex-1 flex flex-col overflow-hidden">
            <div className="p-4 border-b border-border-subtle bg-surface-container-low shrink-0">
              <h3 className="font-headline-2 text-headline-2 text-on-surface">Recent Recordings</h3>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {allRecordings.map(record => (
                <div key={record.id} className="p-3 rounded bg-surface-bg border border-border-subtle">
                  <div className="flex justify-between items-center gap-3">
                  <div>
                    <p className="font-technical text-body-sm text-on-surface font-medium">{record.trackingId}</p>
                    <p className="font-metadata text-metadata text-on-surface-variant">
                      {record.marketplace || 'Unassigned'}{record.orderId ? ` | Order ${record.orderId}` : ''}
                    </p>
                    {record.flyerId ? (
                      <p className="font-metadata text-metadata text-on-surface-variant">
                        Flyer <span className="font-technical">{record.flyerId}</span>
                      </p>
                    ) : null}
                    <p className="font-metadata text-metadata text-on-surface-variant">
                      {new Date(record.timestamp).toLocaleTimeString('en-US', { hour12: false })} - {formatDuration(record.duration)}
                    </p>
                  </div>
                  <span className={`px-2 py-1 rounded text-[11px] font-bold tracking-wide border ${
                    record.status === 'completed' ? 'bg-success/10 text-success border-success/20' : 
                    record.status === 'failed' ? 'bg-critical/10 text-critical border-critical/20' : 
                    'bg-warning/10 text-warning border-warning/20'
                  }`}>
                    {record.status.toUpperCase()}
                  </span>
                  </div>
                  {record.status === 'uploading' && orderCtx && record.trackingId === orderCtx.trackingId && orderCtx.items.length > 0 ? (
                    <div className="mt-3 flex gap-1.5 overflow-hidden">
                      {orderCtx.items.slice(0, 6).map((item) => (
                        <div key={item.sku} className="w-10 h-10 rounded bg-surface-container overflow-hidden shrink-0 relative">
                          {item.imageUrl ? (
                            <SafeImage
                              src={item.imageUrl}
                              alt={item.title || item.sku}
                              fallbackIcon="package_2"
                              className="absolute inset-0 w-full h-full text-sm text-on-surface-variant/50"
                            />
                          ) : (
                            <span className="absolute inset-0 flex items-center justify-center material-symbols-outlined text-sm text-on-surface-variant/50">package_2</span>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
              {allRecordings.length === 0 && (
                <div className="text-center p-4 text-on-surface-variant font-metadata">
                  No recent recordings
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
