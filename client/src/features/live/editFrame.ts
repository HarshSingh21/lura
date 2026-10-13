/**
 * Framing a fence for the editor.
 *
 * "Edit shape" used to pick a zoom from the radius alone (16 for anything under
 * 250 m, 15 under 600 m…). On a 390 px phone a 316 m circle at zoom 15 is 270 px
 * across: its resize handle, due east on the rim, landed at the screen's edge,
 * under the map's control column, where no finger could reach it. The editor
 * now frames the whole fence in the map it actually has, with room on every
 * side for the handles and what floats over the map (the action row, the
 * control column, the editor's toolbar).
 *
 * Dependency-free so `node --test` runs it (editFrame.test.mts).
 */

export type LatLon = { lat: number; lon: number };

/** The points a fence must keep on screen while it is edited: its corners, or its rim. */
export function fenceExtent(fence: { center: LatLon; radiusM: number; polygon?: LatLon[] }): LatLon[] {
  if (fence.polygon && fence.polygon.length >= 3) return fence.polygon;
  const dLat = fence.radiusM / 111_320;
  const dLon = fence.radiusM / (111_320 * Math.cos((fence.center.lat * Math.PI) / 180));
  const { lat, lon } = fence.center;
  return [
    { lat: lat + dLat, lon },
    { lat: lat - dLat, lon },
    { lat, lon: lon + dLon },
    { lat, lon: lon - dLon },
  ];
}

/**
 * editPadding is the margin kept clear around a fence being edited, in px: on
 * a phone the control column (18 px inset + a 44 px column + a gap) and a
 * handle's half-width either side; on a desktop, room for a handle.
 */
export function editPadding(phone: boolean): number {
  return phone ? 96 : 64;
}

/** EDIT_MAX_ZOOM keeps a tiny fence from being framed at street-furniture zoom. */
export const EDIT_MAX_ZOOM = 17;
