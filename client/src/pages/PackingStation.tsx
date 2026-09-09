import React, { useState, useEffect, useRef } from 'react';
import { addRecording, getPendingRecordings, getAllRecordings, appendRecordingChunk, getActiveRecordings, clearActiveRecording, startRecordingSession, ensurePersistentStorage } from '../utils/videoQueue';
import { isDesktopApp } from '../utils/desktop';
import { requestDesktopDownloadTicket, desktopDownloadFileUrl } from '../utils/desktopDownload';
import { mirrorRecordingToDisk, pruneDesktopMirror, reconcileDesktopMirror, setDesktopUploadActive } from '../utils/desktopMirror';
import { useAuth } from '../context/AuthContext';
import { runHealthCheck, HealthCheckResult, getSupportedMp4MimeType } from '../utils/healthCheck';
import { CanvasWatermarker } from '../utils/canvasWatermarker';
import { getApiBaseUrl } from '../utils/apiBase';
import { normalizeScannedId, isDuplicateScan, shouldRequireFlyerId, isMeeshoMarketplace } from '../utils/scanFlow';
import { resolveOrderContext, OrderContext } from '../utils/orderContext';
import { VIDEO_BITRATE_BPS, MIN_RECORDING_HEIGHT } from '../utils/videoQueue';
import toast from 'react-hot-toast';
import { useNavigate } from 'react-router-dom';

const CAMERA_CONSTRAINTS: MediaStreamConstraints[] = [
  // Video only — recordings carry no audio by policy (smaller files, no
  // mic permission prompts, no ambient-voice privacy issues).
  // 1080p first (target quality), then 720p (minimum floor), then fallback.
  {
    video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } },
    audio: false
  },
  {
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
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

export default function PackingStation() {
  const { stationId, station, currentUser } = useAuth();
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
  const [duration, setDuration] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [allRecordings, setAllRecordings] = useState<any[]>([]);
  const [health, setHealth] = useState<HealthCheckResult | null>(null);
  const [cameraStatus, setCameraStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [cameraError, setCameraError] = useState('');
  const [cameraInfo, setCameraInfo] = useState<{ resolution: string; fps: number; label: string } | null>(null);
  const [cameraRestartKey, setCameraRestartKey] = useState(0);
  const [orderCtx, setOrderCtx] = useState<OrderContext | null>(null);
  const [orderResolveNonce, setOrderResolveNonce] = useState(0);
  const orderRequestRef = useRef(0);
  // Flyer mode: the scan input captures the flyer bag instead of starting a
  // new tracking session. Recording itself never waits — it starts on the
  // tracking scan as before.
  const flyerMode = shouldRequireFlyerId({
    flyerScanEnabled,
    isRecording,
    flyerId,
    flyerWaived,
    marketplaceIsMeesho: isMeeshoMarketplace(orderCtx?.marketplace),
    marketplaceKnown: Boolean(orderCtx?.marketplace),
  });
  const [verifiedSkus, setVerifiedSkus] = useState<Set<string>>(new Set());
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
  const transitionQueue = useRef<Promise<void>>(Promise.resolve());
  
  const STATION_ID = stationId || 'UNKNOWN';
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
          orgId: import.meta.env.VITE_ORG_ID,
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

  // Order context for the scanned parcel: mapping table today, OMSGuru
  // SKUs/images once fetchOMSGuruOrder() is implemented. Request-guarded
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
    if (!isRecording) return;
    const guard = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [isRecording]);

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
          if (record.chunks && record.chunks.length > 0) {
            // Mime recorded at session start; a wrong container label here
            // makes the recovered file unplayable.
            const blob = new Blob(record.chunks, { type: record.mimeType || 'video/mp4' });
            const duration = Math.floor((Date.now() - record.startTimestamp) / 1000);
            
            await addRecording({
              id: record.id,
              trackingId: record.trackingId,
              stationId: record.stationId,
              packerId: record.packerId,
              orderId: record.orderId,
              marketplace: record.marketplace,
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
              timestamp: record.startTimestamp,
              duration,
              mimeType: record.mimeType || 'video/mp4',
            });
          }
          await clearActiveRecording(record.id);
        }
        updatePendingCount();
        workerRef.current?.postMessage({ type: 'PROCESS_QUEUE', payload: {} });
      }
    };
    recoverCrashedRecordings().finally(() => {
      // Desktop app: re-import any disk-mirrored videos missing from browser
      // storage, then drop disk copies of already-uploaded videos.
      void reconcileDesktopMirror();
    });
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

  useEffect(() => {
    let interval: any;
    if (isRecording) {
      interval = setInterval(() => setDuration(d => d + 1), 1000);
    } else {
      setDuration(0);
    }
    return () => clearInterval(interval);
  }, [isRecording]);

  const formatDuration = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

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

  const startRecording = async (newTrackingId: string = trackingId): Promise<boolean> => {
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
    let chunkWriteQueue = Promise.resolve();
    activeSessionIdRef.current = sessionId;
    activeSessionStartRef.current = sessionStart;

    await startRecordingSession(sessionId, newTrackingId || 'UNKNOWN', STATION_ID, PACKER_ID, undefined, undefined, mimeType);

    // Recorder setup can fail (e.g. camera stream interrupted). Never leave
    // an orphan active-recording row or a stuck session id behind — the scan
    // would otherwise be lost without a trace.
    let mediaRecorder: MediaRecorder;
    let actualWidth: number | undefined;
    let actualHeight: number | undefined;
    let actualFps: number | undefined;
    try {
      // Grab the canvas stream
      const canvasStream = await watermarkerRef.current.start();

      // Actual output dimensions (not wishes): stored with the recording so
      // metadata and the library show the truth, not hardcoded 2K claims.
      const outputSettings = canvasStream.getVideoTracks()[0]?.getSettings();
      actualWidth = outputSettings?.width;
      actualHeight = outputSettings?.height;
      actualFps = outputSettings?.frameRate ? Math.round(outputSettings.frameRate) : undefined;

      mediaRecorder = new MediaRecorder(canvasStream, {
        mimeType,
        videoBitsPerSecond: VIDEO_BITRATE_BPS
      });
      mediaRecorder.start(2000); // Emit chunk every 2s
    } catch (err) {
      console.error('Failed to start media recorder:', err);
      await clearActiveRecording(sessionId);
      if (activeSessionIdRef.current === sessionId) {
        activeSessionIdRef.current = null;
      }
      toast.error('Failed to start recording. Restart the camera and scan again.');
      return false;
    }

    mediaRecorder.ondataavailable = async (e) => {
      if (e.data.size > 0) {
        chunkWriteQueue = chunkWriteQueue.then(() => appendRecordingChunk(sessionId, e.data));
        await chunkWriteQueue;
      }
    };

    mediaRecorder.onstop = async () => {
      try {
        watermarkerRef.current?.stop();
        
        const recordId = sessionId;
        const finishedDuration = Math.floor((Date.now() - sessionStart) / 1000);
        await chunkWriteQueue;
        
        const active = await getActiveRecordings();
        const currentActive = active.find(r => r.id === recordId);
        
        if (currentActive && currentActive.chunks.length > 0) {
          const blob = new Blob(currentActive.chunks, { type: mimeType });
          const finishedFlyerId = flyerIdRef.current;
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
            fps: actualFps,
            videoBitrate: VIDEO_BITRATE_BPS,
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
        }
      } finally {
        if (activeSessionIdRef.current === sessionId) {
          activeSessionIdRef.current = null;
        }
        if (mediaRecorderRef.current === mediaRecorder) {
          mediaRecorderRef.current = null;
        }
        resolveStopRecordingRef.current?.();
        resolveStopRecordingRef.current = null;
        stopRecordingPromiseRef.current = null;
      }
    };

    mediaRecorderRef.current = mediaRecorder;
    setIsRecording(true);
    setTrackingId(newTrackingId);
    resetFlyerState();
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

  // Scan success chirp (recording started, next parcel ready).

  // A missing order is NOT an error: the parcel may simply predate the order
  // sync. Recording proceeds regardless, and details attach when found
  // (Retry button, later scans, or the upload worker enriching at upload).
  const isResolvingOrder = Boolean(trackingId && !orderCtx);

  const handleBarcodeScan = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      const nextTrackingId = normalizeScannedId(scanInput);
      setScanInput(''); // Immediately clear input for rapid scanning
      if (!nextTrackingId) return;
      // Flyer-bag step: while a session awaits its flyer, every scan is a
      // flyer ID — it must never split the session or start a new one.
      if (flyerMode) {
        setFlyerId(nextTrackingId);
        flyerIdRef.current = nextTrackingId;
        playBeep();
        focusScanInput();
        return;
      }
      playBeep();

      transitionQueue.current = transitionQueue.current.then(async () => {
        try {
          if (activeSessionIdRef.current) {
            // Scanner double-read of the parcel already being recorded:
            // keep the single session instead of splitting its video in two.
            const active = await getActiveRecordings();
            const currentActive = active.find(r => r.id === activeSessionIdRef.current);
            if (currentActive && isDuplicateScan(currentActive.trackingId, nextTrackingId)) {
              toast('Already recording this tracking ID');
              focusScanInput();
              return;
            }
            await stopRecording();
          }
          await startRecording(nextTrackingId);
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
      watermarkerRef.current?.stop();
      streamRef.current = null;
      watermarkerRef.current = null;
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
      durationSeconds: duration,
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
          
          watermarkerRef.current = new CanvasWatermarker(stream, STATION_ID, 'IDLE', PACKER_ID);

          const track = stream.getVideoTracks()[0];
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
      watermarkerRef.current = null;
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
      {/* TopNavBar */}
      <header className="bg-surface-container-lowest flex flex-col lg:flex-row lg:justify-between lg:items-center gap-3 px-gutter py-3 min-h-[64px] border-b border-border-subtle shrink-0">
        <div className="flex flex-col xl:flex-row xl:items-center gap-3 xl:gap-6 min-w-0">
          <h2 className="font-headline-1 text-headline-1 font-bold text-on-background">{STATION_ID}</h2>
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
          <div className="h-6 w-px bg-border-subtle mx-2"></div>
          <button
            type="button"
            title="System health"
            onClick={() => navigate('/system-health')}
            className="text-on-surface-variant hover:text-primary transition-colors"
          >
            <span className="material-symbols-outlined">notifications</span>
          </button>
          <button
            type="button"
            title="Admin settings"
            onClick={() => navigate('/settings')}
            className="text-on-surface-variant hover:text-primary transition-colors"
          >
            <span className="material-symbols-outlined">account_circle</span>
          </button>
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
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/80 text-white">
                <span className={`material-symbols-outlined text-4xl ${cameraStatus === 'loading' ? 'animate-spin' : ''}`}>
                  {cameraStatus === 'loading' ? 'progress_activity' : 'videocam_off'}
                </span>
                <p className="font-body-sm text-body-sm">
                  {cameraStatus === 'loading' ? 'Starting camera...' : cameraError || 'Camera unavailable'}
                </p>
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
          <div className="bg-surface-card rounded-lg border border-border-subtle p-4 shadow-sm flex flex-col 2xl:flex-row 2xl:items-center gap-6">
            <div className="flex-1">
              <div className="flex items-center justify-between gap-3 mb-2">
                <p className="font-metadata text-metadata text-on-surface-variant uppercase tracking-wider">
                  {flyerMode ? 'Scan Flyer ID' : 'Scan Tracking ID'}
                </p>
                <span className="flex items-center gap-2" title="Meesho flyer capture: when on, each session also needs the flyer-bag barcode">
                  <span className="font-metadata text-metadata text-on-surface-variant uppercase tracking-wider">Flyer scan</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={flyerScanEnabled}
                    aria-label="Toggle flyer ID scanning"
                    onClick={toggleFlyerScan}
                    className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${flyerScanEnabled ? 'bg-primary' : 'bg-surface-container-high border border-outline-variant'}`}
                  >
                    <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${flyerScanEnabled ? 'left-[18px]' : 'left-0.5'}`} />
                  </button>
                </span>
              </div>
              <div className="relative">
                <input 
                  className={`w-full bg-surface-container border rounded-lg p-4 font-technical text-headline-1 text-on-surface placeholder:text-on-surface-variant/40 focus:ring-2 focus:outline-none ${flyerMode ? 'border-warning/60 focus:ring-warning/50' : 'border-outline-variant focus:ring-primary'}`}
                  placeholder={flyerMode ? 'Scan Meesho flyer bag…' : 'Scan parcel to start recording...'}
                  type="text" 
                  autoFocus 
                  ref={scanInputRef}
                  value={scanInput}
                  onChange={(e) => setScanInput(e.target.value)}
                  onKeyDown={handleBarcodeScan}
                />
                <span className="material-symbols-outlined absolute right-4 top-4 text-on-surface-variant animate-pulse">barcode_scanner</span>
              </div>
              {flyerMode && (
                <div className="mt-2 flex items-center justify-between gap-2">
                  <p className="font-body-sm text-body-sm text-warning">Tracking {trackingId} recording — now scan its flyer bag.</p>
                  <button
                    type="button"
                    onClick={() => { setFlyerWaived(true); focusScanInput(); }}
                    className="font-body-sm text-body-sm text-secondary hover:text-primary transition-colors shrink-0 underline underline-offset-2"
                  >
                    Skip flyer
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
            {flyerScanEnabled && (isRecording || trackingId) && (
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
              <span title="Start time">{isRecording ? new Date().toLocaleTimeString('en-US', { hour12: false }) : "--:--:--"}</span>
              <span title="Duration" className="text-on-surface font-medium">{formatDuration(duration)}</span>
              {cameraInfo && (
                <span className="truncate" title={`${cameraInfo.label} • ${cameraInfo.resolution} • ${cameraInfo.fps} FPS`}>
                  {cameraInfo.resolution} • {cameraInfo.fps}fps
                </span>
              )}
            </div>
          </div>

          {/* Order Details (OMSGuru-ready: SKUs/images auto-fill once connected) */}
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
                {orderCtx?.marketplace ? (
                  <span className="px-2 py-1 rounded text-[11px] font-bold tracking-wide border bg-primary/10 text-primary border-primary/20">
                    {orderCtx.marketplace.toUpperCase()}
                  </span>
                ) : (
                  <span className="px-2 py-1 rounded text-[11px] font-bold tracking-wide border bg-surface-variant text-on-surface-variant border-outline-variant">
                    UNASSIGNED
                  </span>
                )}
                {orderCtx?.status && (
                  <span className="px-2 py-1 rounded text-[11px] font-bold tracking-wide border bg-surface-variant text-on-surface-variant border-outline-variant">
                    {orderCtx.status}
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
                <div>
                  <p className="font-metadata text-metadata text-on-surface-variant mb-1 uppercase tracking-wider">Order ID</p>
                  <p className="font-technical text-body-lg text-on-surface">{orderCtx?.orderId || 'Not mapped yet'}</p>
                </div>
                {orderCtx && orderCtx.items.length > 0 ? (
                  <>
                    {(() => {
                      const units = orderCtx.items.reduce((sum, item) => sum + (item.quantity || 0), 0);
                      const skus = new Set(orderCtx.items.map((item) => item.sku)).size;
                      const isMulti = units > 1 || skus > 1;
                      const verifiedCount = orderCtx.items.filter((item) => verifiedSkus.has(item.sku)).length;
                      const allVerified = verifiedCount === orderCtx.items.length;
                      return (
                        <>
                          {isMulti && (
                            <div className={`rounded-lg p-3 font-body-sm text-body-sm flex items-center gap-2 border ${allVerified ? 'bg-success/10 border-success/30 text-success' : 'bg-warning/10 border-warning/30 text-warning'}`}>
                              <span className="material-symbols-outlined text-body-sm">warning</span>
                              {allVerified
                                ? `All ${units} unit${units !== 1 ? 's' : ''} verified — ready to seal.`
                                : `MULTI-ITEM: ${units} unit${units !== 1 ? 's' : ''} • ${skus} SKU${skus !== 1 ? 's' : ''} — tap each item as you verify.`}
                            </div>
                          )}
                          <div className="grid grid-cols-3 gap-2">
                            {orderCtx.items.map((item) => {
                              const verified = verifiedSkus.has(item.sku);
                              return (
                                <button
                                  key={item.sku}
                                  type="button"
                                  onClick={() => {
                                    setVerifiedSkus((prev) => {
                                      const next = new Set(prev);
                                      if (next.has(item.sku)) next.delete(item.sku);
                                      else next.add(item.sku);
                                      return next;
                                    });
                                  }}
                                  title={verified ? 'Tap to unmark' : 'Tap when packed'}
                                  className={`rounded-lg border bg-surface-bg overflow-hidden text-left transition-all ${verified ? 'border-success/50 ring-1 ring-success/40' : 'border-border-subtle hover:border-primary/40'}`}
                                >
                                  <div className="aspect-square flex items-center justify-center bg-surface-container overflow-hidden relative">
                                    <span className="material-symbols-outlined text-2xl text-on-surface-variant/50">package_2</span>
                                    {item.imageUrl ? (
                                      <img
                                        src={item.imageUrl}
                                        alt={item.title || item.sku}
                                        className="absolute inset-0 w-full h-full object-cover"
                                        loading="lazy"
                                        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                                      />
                                    ) : null}
                                    {verified && (
                                      <span className="absolute top-1 right-1 w-5 h-5 rounded-full bg-success text-white flex items-center justify-center">
                                        <span className="material-symbols-outlined text-[14px]">check</span>
                                      </span>
                                    )}
                                    <span className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded bg-black/60 text-white font-metadata text-metadata">
                                      x{item.quantity}
                                    </span>
                                  </div>
                                  <div className="p-1.5">
                                    <p className="font-technical text-[11px] text-on-surface truncate" title={item.title || item.sku}>{item.title || item.sku}</p>
                                     <p className="font-metadata text-metadata text-on-surface-variant truncate" title={item.subOrderId || item.channelOrderId || item.sku}>
                                       {item.subOrderId || item.channelOrderId || item.sku}
                                    </p>
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
                      ? 'No items yet — they appear after the next order sync.'
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
                          <span className="absolute inset-0 flex items-center justify-center material-symbols-outlined text-sm text-on-surface-variant/50">package_2</span>
                          {item.imageUrl ? (
                            <img
                              src={item.imageUrl}
                              alt=""
                              className="absolute inset-0 w-full h-full object-cover"
                              loading="lazy"
                              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                            />
                          ) : null}
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
