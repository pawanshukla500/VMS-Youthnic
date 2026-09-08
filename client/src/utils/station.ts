// Packing-station identity resolution (shared rule, unit-tested).
//
// The admin assigns a default station per user (Users page →
// organization_members.default_station_id), surfaced by /api/me. A legacy
// Firestore users-doc stationId still works as a fallback so older
// assignments keep working. Server assignment always wins when present —
// the split-brain default (server set, Firestore empty) is exactly how
// stations ended up UNKNOWN everywhere.

export interface AssignedStation {
  id: string;
  code: string;
  name?: string | null;
}

function cleanCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function resolveStationCode(
  serverStation: AssignedStation | null | undefined,
  firestoreStationId: string | null | undefined
): string | null {
  return cleanCode(serverStation?.code) || cleanCode(firestoreStationId);
}

export function resolveStationName(
  serverStation: AssignedStation | null | undefined
): string | null {
  if (!serverStation || typeof serverStation.name !== 'string') return null;
  const trimmed = serverStation.name.trim();
  return trimmed || null;
}
