/** Shared by the Leaflet and Google versions of the shop pin map. */
export interface LocationMapProps {
  latitude: number | null;
  longitude: number | null;
  center: { latitude: number; longitude: number; zoom?: number } | null;
  onChange: (latitude: number, longitude: number) => void;
  /** A rough device fix: drawn as a circle and zoomed to; the owner taps the entrance inside it. */
  area?: { latitude: number; longitude: number; radius: number } | null;
}

/** Until a pin or detected area exists, open on India (where shops are). Pins anywhere in the world still work. */
export const INDIA_CENTER: [number, number] = [22.5, 79];
export const INDIA_ZOOM = 4;
/** Below this zoom a tap only zooms in; pins are placed at street level. */
export const MIN_PIN_ZOOM = 15;
export const PIN_ZOOM = 17;
