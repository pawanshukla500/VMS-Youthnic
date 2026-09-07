// PVMS Packing Station — preload bridge (context-isolated).
// The ONLY surface the renderer gets: recording disk-mirror storage,
// upload-activity signalling, and the app version. No Node access.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true as const,
  platform: process.platform,
  getVersion: () => ipcRenderer.invoke('desktop:get-version'),
  saveRecording: (id: string, ext: string, data: ArrayBuffer, meta: unknown) =>
    ipcRenderer.invoke('desktop:save-recording', { id, ext, data, meta }),
  readRecording: (id: string) => ipcRenderer.invoke('desktop:read-recording', { id }),
  listRecordings: () => ipcRenderer.invoke('desktop:list-recordings'),
  deleteRecording: (id: string) => ipcRenderer.invoke('desktop:delete-recording', { id }),
  setUploadActive: (active: boolean) => ipcRenderer.send('desktop:upload-hold', { active: active === true }),
});
