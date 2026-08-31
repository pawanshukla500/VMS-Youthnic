# DESIGN.md - Packing Video Management System

## Core Product Workflow
The system records warehouse packing activity using a webcam and associates each recording with a scanned Tracking ID / AWB.

Primary workflow:
1. Camera Ready
2. Scan Tracking ID A
3. Start Recording A
4. Packer packs parcel
5. Scan Tracking ID B
6. Finalize Recording A
7. Immediately Start Recording B
8. Queue A
9. Upload A to Firebase in background

The next recording must never wait for the previous upload to finish.
Recording and uploading are independent pipelines.

## Recommended Architecture
- Desktop Client: Electron, React, TypeScript, Vite
- Backend: Node.js, TypeScript, Fastify or Express
- Database: PostgreSQL
- Authentication: Firebase Authentication
- Media Storage: Firebase Storage
- Privileged Firebase Operations: Firebase Admin SDK

## Sidebar Navigation
- OVERVIEW: Dashboard
- PACKING: Packing Station, Video Library, Upload Queue
- OPERATIONS: Reviews, Tracking History, Stations
- ADMINISTRATION: Users, Roles & Permissions, Audit Logs, Settings
- BOTTOM: System Status, Profile, Sign Out

## Important Rules
- Never lose a packing video.
- Never attach a video to the wrong Tracking ID.
- Never wait for Firebase upload before beginning the next recording.
- Keep the camera stream alive between parcels.
- Use PostgreSQL as the searchable metadata index.
- Use Firebase Storage as the video object store.
- Every visible button, menu, filter, control, route, and action must work.
