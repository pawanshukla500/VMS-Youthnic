import React, { useState, useEffect, useRef } from 'react';
import useSWR from 'swr';
import { getDownloadURL, ref } from 'firebase/storage';
import { storage } from '../utils/firebase';
import { authFetch } from '../utils/authFetch';
import { getApiBaseUrl } from '../utils/apiBase';
import toast from 'react-hot-toast';

const fetcher = async (url: string) => {
  const res = await authFetch(url);
  if (!res.ok) throw new Error('Network response was not ok');
  return res.json();
};

export default function VideoLibrary() {
  const [selectedVideo, setSelectedVideo] = useState<any>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [playbackRate, setPlaybackRate] = useState<number>(1);
  const videoRef = useRef<HTMLVideoElement>(null);
  
  const [search, setSearch] = useState('');
  const [station, setStation] = useState('All Stations');
  const [reviewStatus, setReviewStatus] = useState('All Statuses');
  const [marketplace, setMarketplace] = useState('All Marketplaces');
  const [page, setPage] = useState(1);
  const limit = 20;

  const API_URL = getApiBaseUrl();
  
  const query = new URLSearchParams();
  if (search) query.append('search', search);
  if (station && station !== 'All Stations') query.append('station', station);
  if (reviewStatus && reviewStatus !== 'All Statuses') query.append('reviewStatus', reviewStatus);
  if (marketplace && marketplace !== 'All Marketplaces') query.append('marketplace', marketplace);
  query.append('page', page.toString());
  query.append('limit', limit.toString());

  const { data, error, isLoading, mutate } = useSWR(`${API_URL}/api/videos?${query.toString()}`, fetcher, {
    keepPreviousData: true
  });

  const videos = data?.videos || data || [];
  const marketplaces = data?.marketplaces || [];
  const totalCount = data?.total || videos.length;
  const totalPages = Math.ceil(totalCount / limit) || 1;
  const isUploaded = (status?: string) => ['uploaded', 'completed'].includes((status || '').toLowerCase());

  useEffect(() => {
    if (selectedVideo && selectedVideo.storagePath) {
      getDownloadURL(ref(storage, selectedVideo.storagePath))
        .then(url => setVideoUrl(url))
        .catch(err => {
          console.error('Error fetching video URL:', err);
          // If we fail to get from Firebase (maybe not uploaded yet or permissions), we fallback to the local url if it was there
          setVideoUrl(selectedVideo.url || null);
        });
    } else if (selectedVideo && selectedVideo.url) {
       setVideoUrl(selectedVideo.url);
    } else {
      setVideoUrl(null);
    }
  }, [selectedVideo]);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate, videoUrl]);

  const handleUpdateReviewStatus = async (status: string) => {
    if (!selectedVideo) return;
    const API_URL = getApiBaseUrl();
    try {
      await authFetch(`${API_URL}/api/videos/${selectedVideo.id}/review`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });
      // Update local state optimistically
      setSelectedVideo({ ...selectedVideo, reviewStatus: status });
      mutate(); // Re-fetch the list
      toast.success(`Video marked as ${status}`);
    } catch (err) {
      console.error('Failed to update review status', err);
      toast.error('Failed to update status');
    }
  };

  const handleExport = async () => {
    const API_URL = getApiBaseUrl();
    try {
      const res = await authFetch(`${API_URL}/api/videos/report`);
      if (!res.ok) throw new Error(`Export failed with status ${res.status}`);
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'vms_report.csv';
      a.click();
      window.URL.revokeObjectURL(url);
      toast.success('Report downloaded');
    } catch (err) {
      console.error('Failed to export', err);
      toast.error('Failed to export report');
    }
  };

  const handleCopyLink = async () => {
    if (!videoUrl) {
      toast.error('Video link is still loading');
      return;
    }
    try {
      await navigator.clipboard.writeText(videoUrl);
      toast.success('Shareable link copied');
    } catch {
      // Clipboard API unavailable (permissions) — fall back to a prompt.
      window.prompt('Copy video link:', videoUrl);
    }
  };

  const handleDownload = async () => {
    if (!selectedVideo) {
      toast.error('Select a video first');
      return;
    }

    if (!API_URL) {
      toast.error('API URL is not configured');
      return;
    }

    if (!isUploaded(selectedVideo.status)) {
      toast.error('Video URL is not ready yet');
      return;
    }

    try {
      const res = await authFetch(`${API_URL}/api/videos/${selectedVideo.id}/download`);
      if (!res.ok) throw new Error(`Download failed with status ${res.status}`);
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${selectedVideo.order_id || selectedVideo.tracking_id || selectedVideo.id || 'video'}.mp4`;
      a.click();
      window.URL.revokeObjectURL(url);
      toast.success('Download started');
    } catch(err) {
      console.error('Download failed', err);
      toast.error('Download failed');
    }
  };

  const handleDeleteVideo = async () => {
    if (!selectedVideo) return;
    if (!window.confirm('Are you sure you want to delete this video permanently?')) return;

    try {
      const res = await authFetch(`${API_URL}/api/videos/${selectedVideo.id}`, {
        method: 'DELETE'
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || 'Delete failed');
      }
      
      toast.success('Video deleted');
      mutate();
      setSelectedVideo(null);
      setVideoUrl(null);
    } catch (err) {
      console.error('Failed to delete', err);
      toast.error(err instanceof Error ? err.message : 'Failed to delete video');
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-screen relative bg-surface-bg overflow-hidden">
      {/* TopNavBar */}
      <header className="bg-surface-container-lowest flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 px-gutter py-3 min-h-[64px] border-b border-border-subtle shrink-0">
        <div className="flex items-center gap-6 min-w-0">
          <h2 className="font-headline-1 text-headline-1 font-bold text-on-background">Video Library</h2>
        </div>
        <div className="flex items-center gap-4">
          <button onClick={handleExport} className="flex items-center gap-2 bg-primary text-on-primary px-4 py-2 rounded-lg font-medium hover:bg-primary/90 transition-colors shadow-sm">
            <span className="material-symbols-outlined text-sm">download</span>
            Export Report
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col p-gutter gap-4 overflow-hidden relative">
        {/* Filters and Search Bar */}
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 bg-surface-card p-4 rounded-lg border border-border-subtle shadow-sm shrink-0">
          <div className="flex items-center gap-4 flex-1">
            <div className="relative w-full max-w-md">
              <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant">search</span>
              <input 
                type="text" 
                placeholder="Search by Tracking ID, Order ID, Marketplace..." 
                className="w-full bg-surface-bg border border-border-heavy rounded pl-10 pr-4 py-2 font-body-sm text-body-sm text-on-surface focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary placeholder:text-on-surface-variant" 
                value={search}
                onChange={e => { setSearch(e.target.value); setPage(1); }}
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative">
              <select
                value={marketplace}
                onChange={e => { setMarketplace(e.target.value); setPage(1); }}
                className="appearance-none bg-surface-bg border border-border-heavy rounded pl-4 pr-10 py-2 font-body-sm text-body-sm text-on-surface focus:outline-none focus:border-primary cursor-pointer hover:bg-surface-variant transition-colors"
              >
                <option>All Marketplaces</option>
                {marketplaces.map((item: any) => (
                  <option key={item.marketplace}>{item.marketplace}</option>
                ))}
              </select>
              <span className="material-symbols-outlined absolute right-3 top-1/2 -translate-y-1/2 text-on-surface-variant pointer-events-none text-sm">expand_more</span>
            </div>
            <div className="relative">
              <select 
                value={station}
                onChange={e => { setStation(e.target.value); setPage(1); }}
                className="appearance-none bg-surface-bg border border-border-heavy rounded pl-4 pr-10 py-2 font-body-sm text-body-sm text-on-surface focus:outline-none focus:border-primary cursor-pointer hover:bg-surface-variant transition-colors"
              >
                <option>All Stations</option>
                <option>PACK-01</option>
                <option>PACK-02</option>
                <option>PACK-03</option>
              </select>
              <span className="material-symbols-outlined absolute right-3 top-1/2 -translate-y-1/2 text-on-surface-variant pointer-events-none text-sm">expand_more</span>
            </div>
            <div className="relative">
              <select 
                value={reviewStatus}
                onChange={e => { setReviewStatus(e.target.value); setPage(1); }}
                className="appearance-none bg-surface-bg border border-border-heavy rounded pl-4 pr-10 py-2 font-body-sm text-body-sm text-on-surface focus:outline-none focus:border-primary cursor-pointer hover:bg-surface-variant transition-colors"
              >
                <option>All Statuses</option>
                <option>Uploaded</option>
                <option>Uploading</option>
                <option>Failed</option>
                <option>Disputed</option>
                <option>Resolved</option>
              </select>
              <span className="material-symbols-outlined absolute right-3 top-1/2 -translate-y-1/2 text-on-surface-variant pointer-events-none text-sm">expand_more</span>
            </div>
          </div>
        </div>

        {/* Data Table */}
        {isLoading && (
          <div className="flex-1 flex items-center justify-center bg-white/60 backdrop-blur-md rounded-xl border border-white/20 shadow-sm">
            <span className="material-symbols-outlined animate-spin text-primary text-5xl">progress_activity</span>
          </div>
        )}

        {error && (
          <div className="bg-error-container text-on-error-container p-4 rounded-lg flex items-start gap-3">
            <span className="material-symbols-outlined text-error">error</span>
            <p className="font-body-sm text-body-sm">{error.message || 'Error loading videos'}</p>
          </div>
        )}

        {!isLoading && !error && (
          <div className="flex-1 bg-white/60 backdrop-blur-md rounded-xl border border-white/20 shadow-sm flex flex-col overflow-hidden animate-fade-in-up">
            <div className="flex-1 overflow-auto">
              <table className="w-full text-left border-collapse min-w-[1040px]">
              <thead className="sticky top-0 bg-surface-container-low z-10 shadow-sm">
                <tr>
                  <th className="p-4 font-metadata text-metadata text-secondary font-semibold border-b border-border-subtle w-12"></th>
                  <th className="p-4 font-metadata text-metadata text-secondary font-semibold border-b border-border-subtle">Tracking ID</th>
                  <th className="p-4 font-metadata text-metadata text-secondary font-semibold border-b border-border-subtle">Order ID</th>
                  <th className="p-4 font-metadata text-metadata text-secondary font-semibold border-b border-border-subtle">Marketplace</th>
                  <th className="p-4 font-metadata text-metadata text-secondary font-semibold border-b border-border-subtle">Date & Time</th>
                  <th className="p-4 font-metadata text-metadata text-secondary font-semibold border-b border-border-subtle">Duration</th>
                  <th className="p-4 font-metadata text-metadata text-secondary font-semibold border-b border-border-subtle">Packer</th>
                  <th className="p-4 font-metadata text-metadata text-secondary font-semibold border-b border-border-subtle">Station</th>
                  <th className="p-4 font-metadata text-metadata text-secondary font-semibold border-b border-border-subtle">Status</th>
                  <th className="p-4 border-b border-border-subtle w-12"></th>
                </tr>
              </thead>
              <tbody>
                {videos.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="py-20 text-center">
                      <div className="flex flex-col items-center justify-center text-secondary">
                        <span className="material-symbols-outlined text-6xl mb-4 opacity-50">videocam_off</span>
                        <h3 className="font-headline-2 text-headline-2 text-on-surface mb-1">No videos found</h3>
                        <p className="font-body-sm text-body-sm">Try adjusting your search or filters.</p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  videos.map((video: any) => (
                    <tr 
                      key={video.id} 
                      className="group border-b border-border-subtle/50 hover:bg-white/80 transition-colors cursor-pointer"
                      onClick={() => setSelectedVideo(video)}
                    >
                      <td className="p-4">
                        <div className="w-12 h-8 bg-surface-container-high rounded flex items-center justify-center overflow-hidden relative border border-border-heavy">
                          <span className="material-symbols-outlined text-secondary relative z-10 text-xl" style={{fontVariationSettings: "'FILL' 1"}}>play_circle</span>
                        </div>
                      </td>
                      <td className="p-4 font-technical text-technical text-on-surface group-hover:text-primary transition-colors">{video.tracking_id || video.id}</td>
                      <td className="p-4 font-technical text-technical text-on-surface">{video.order_id || '-'}</td>
                      <td className="p-4 text-on-surface">{video.marketplace || 'Unassigned'}</td>
                      <td className="p-4 text-on-surface">
                        {video.date}<br/><span className="text-secondary font-metadata text-metadata">{video.time}</span>
                      </td>
                      <td className="p-4 text-on-surface font-technical text-technical">{video.duration}</td>
                      <td className="p-4 text-on-surface">{video.packer}</td>
                      <td className="p-4 text-on-surface font-technical text-technical">{video.station}</td>
                      <td className="p-4">
                        {isUploaded(video.status) ? (
                          <div className="flex flex-col gap-1">
                            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-success/10 text-success text-[11px] font-medium w-max border border-success/20">
                              <span className="material-symbols-outlined text-[14px]">check_circle</span> Uploaded
                            </span>
                            {video.reviewStatus === 'disputed' && (
                              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-critical/10 text-critical text-[11px] font-medium w-max border border-critical/20">
                                <span className="material-symbols-outlined text-[14px]">report</span> Disputed
                              </span>
                            )}
                            {video.reviewStatus === 'resolved' && (
                              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-surface-variant text-secondary text-[11px] font-medium w-max border border-border-heavy">
                                <span className="material-symbols-outlined text-[14px]">done_all</span> Resolved
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-surface-container-high text-warning text-[11px] font-medium w-max">
                            <div className="w-1.5 h-1.5 rounded-full bg-warning animate-pulse"></div> Uploading...
                          </span>
                        )}
                      </td>
                      <td className="p-4 text-right">
                        <button
                          type="button"
                          title="Open details"
                          onClick={(event) => {
                            event.stopPropagation();
                            setSelectedVideo(video);
                          }}
                          className="p-2 text-secondary hover:text-primary hover:bg-surface-variant rounded-full transition-colors"
                        >
                          <span className="material-symbols-outlined">more_vert</span>
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {/* Pagination */}
          <div className="bg-surface border-t border-border-subtle p-4 flex items-center justify-between">
            <span className="font-metadata text-metadata text-secondary">
              Showing {videos.length > 0 ? (page - 1) * limit + 1 : 0} to {Math.min(page * limit, totalCount)} of {totalCount} entries
            </span>
            <div className="flex items-center gap-2">
              <button 
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="p-1.5 rounded border border-border-subtle text-secondary hover:bg-surface-variant disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-sm">chevron_left</span>
              </button>
              <span className="w-8 h-8 rounded bg-primary text-on-primary font-medium text-sm flex items-center justify-center" aria-current="page">{page}</span>
              <button 
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="p-1.5 rounded border border-border-subtle text-secondary hover:bg-surface-variant disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-sm">chevron_right</span>
              </button>
            </div>
          </div>
          </div>
        )}
      </main>

      {/* Right Side In-Page Preview Drawer */}
      <aside 
        className={`fixed right-0 top-0 md:top-topbar-height h-screen md:h-[calc(100vh-64px)] w-[min(420px,calc(100vw-72px))] md:w-[420px] bg-surface-card border-l border-border-heavy shadow-2xl transition-transform duration-300 ease-in-out transform ${selectedVideo ? 'translate-x-0' : 'translate-x-full'} z-30 flex flex-col`}
      >
        {/* Drawer Header */}
        <div className="p-4 border-b border-border-subtle flex justify-between items-center bg-surface shrink-0">
          <h3 className="font-headline-2 text-headline-2 text-on-surface">Video Details</h3>
          <button 
            className="p-1.5 rounded-full text-secondary hover:bg-surface-variant transition-colors"
            onClick={() => {
              setSelectedVideo(null);
              setVideoUrl(null);
            }}
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
        
        {/* Scrollable Content */}
        {selectedVideo && (
          <div className="flex-1 overflow-y-auto">
            {/* Video Player Area */}
            <div className="w-full aspect-video bg-black relative group">
              {videoUrl ? (
                <video ref={videoRef} src={videoUrl} controls className="w-full h-full object-contain" />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center text-white flex-col gap-2">
                  <span className="material-symbols-outlined animate-spin">progress_activity</span>
                  <span>Loading Secure Video...</span>
                </div>
              )}
              {/* Action Bar inside Drawer */}
              <div className="p-2 border-t border-border-subtle bg-surface flex flex-wrap justify-between gap-2">
                <button 
                  onClick={handleDeleteVideo}
                  disabled={!selectedVideo}
                  className="px-3 py-1.5 bg-critical/10 text-critical rounded flex items-center gap-2 hover:bg-critical/20 transition-colors disabled:opacity-50 font-medium"
                >
                  <span className="material-symbols-outlined text-sm">delete</span> Delete
                </button>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={handleCopyLink}
                    disabled={!selectedVideo || !videoUrl}
                    title="Copy a shareable link to this video"
                    className="px-3 py-1.5 bg-surface-variant text-on-surface-variant rounded flex items-center gap-2 hover:bg-surface-container-high transition-colors disabled:opacity-50 font-medium"
                  >
                    <span className="material-symbols-outlined text-sm">link</span> Copy link
                  </button>
                  <button 
                    onClick={handleDownload}
                    disabled={!selectedVideo || !isUploaded(selectedVideo.status)}
                    className="px-3 py-1.5 bg-surface-variant text-on-surface-variant rounded flex items-center gap-2 hover:bg-surface-container-high transition-colors disabled:opacity-50 font-medium"
                  >
                    <span className="material-symbols-outlined text-sm">download</span> Download
                  </button>
                </div>
              </div>
            </div>
            
            {/* Playback & Dispute Controls */}
            <div className="p-card-padding border-t border-border-subtle flex flex-col gap-4">
              <div>
                <p className="font-metadata text-metadata text-secondary mb-2">Playback Speed (Slow-Mo)</p>
                <div className="flex gap-2">
                  {[0.25, 0.5, 1, 2].map(rate => (
                    <button 
                      key={rate}
                      onClick={() => { if(videoRef.current) videoRef.current.playbackRate = rate; setPlaybackRate(rate); }}
                      className={`px-3 py-1.5 rounded border text-sm font-medium transition-colors ${playbackRate === rate ? 'bg-primary text-on-primary border-primary' : 'bg-surface border-border-subtle text-secondary hover:bg-surface-variant'}`}
                    >
                      {rate}x
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <p className="font-metadata text-metadata text-secondary mb-2">Review Status</p>
                <div className="flex gap-2">
                  <button 
                    onClick={() => handleUpdateReviewStatus('disputed')}
                    className={`flex-1 py-2 rounded text-sm font-medium border transition-colors flex items-center justify-center gap-2 ${selectedVideo.reviewStatus === 'disputed' ? 'bg-critical text-white border-critical' : 'bg-surface border-critical text-critical hover:bg-critical/10'}`}
                  >
                    <span className="material-symbols-outlined text-[18px]">report</span> Mark Disputed
                  </button>
                  <button 
                    onClick={() => handleUpdateReviewStatus('resolved')}
                    className={`flex-1 py-2 rounded text-sm font-medium border transition-colors flex items-center justify-center gap-2 ${selectedVideo.reviewStatus === 'resolved' ? 'bg-success text-white border-success' : 'bg-surface border-success text-success hover:bg-success/10'}`}
                  >
                    <span className="material-symbols-outlined text-[18px]">check_circle</span> Mark Resolved
                  </button>
                </div>
              </div>
            </div>
            
            {/* Metadata Section */}
            <div className="p-card-padding flex flex-col gap-6">
              <div className="flex justify-between items-start">
                <div>
                  <p className="font-metadata text-metadata text-secondary mb-1">Tracking ID</p>
                  <h4 className="font-headline-1 text-headline-1 text-primary tracking-tight">{selectedVideo.tracking_id || selectedVideo.id}</h4>
                </div>
                <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-surface-container-high border border-border-subtle text-on-surface font-metadata text-metadata">
                  <span className="material-symbols-outlined text-sm">hd</span> 2K Res
                </span>
              </div>
              <div className="grid grid-cols-2 gap-y-4 gap-x-4">
                <div>
                  <p className="font-metadata text-metadata text-secondary mb-0.5 flex items-center gap-1">
                    <span className="material-symbols-outlined text-[14px]">receipt_long</span> Order ID
                  </p>
                  <p className="font-body-sm text-body-sm text-on-surface font-medium font-technical text-technical">{selectedVideo.order_id || '-'}</p>
                </div>
                <div>
                  <p className="font-metadata text-metadata text-secondary mb-0.5 flex items-center gap-1">
                    <span className="material-symbols-outlined text-[14px]">storefront</span> Marketplace
                  </p>
                  <p className="font-body-sm text-body-sm text-on-surface font-medium">{selectedVideo.marketplace || 'Unassigned'}</p>
                </div>
                <div>
                  <p className="font-metadata text-metadata text-secondary mb-0.5 flex items-center gap-1">
                    <span className="material-symbols-outlined text-[14px]">calendar_month</span> Date
                  </p>
                  <p className="font-body-sm text-body-sm text-on-surface font-medium">{selectedVideo.date}</p>
                </div>
                <div>
                  <p className="font-metadata text-metadata text-secondary mb-0.5 flex items-center gap-1">
                    <span className="material-symbols-outlined text-[14px]">schedule</span> Time
                  </p>
                  <p className="font-body-sm text-body-sm text-on-surface font-medium font-technical text-technical">{selectedVideo.time}</p>
                </div>
                <div>
                  <p className="font-metadata text-metadata text-secondary mb-0.5 flex items-center gap-1">
                    <span className="material-symbols-outlined text-[14px]">person</span> Packer
                  </p>
                  <p className="font-body-sm text-body-sm text-on-surface font-medium">{selectedVideo.packer}</p>
                </div>
                <div>
                  <p className="font-metadata text-metadata text-secondary mb-0.5 flex items-center gap-1">
                    <span className="material-symbols-outlined text-[14px]">point_of_sale</span> Station
                  </p>
                  <p className="font-body-sm text-body-sm text-on-surface font-medium font-technical text-technical">{selectedVideo.station}</p>
                </div>
              </div>
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
