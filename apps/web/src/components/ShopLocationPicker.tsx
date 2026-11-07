import { useEffect, useRef } from 'react';
import L, { type LeafletMouseEvent } from 'leaflet';
import 'leaflet/dist/leaflet.css';

interface ShopLocationPickerProps {
  latitude: number | null;
  longitude: number | null;
  center: { latitude: number; longitude: number; zoom?: number } | null;
  onChange: (latitude: number, longitude: number) => void;
  /** What the map calls the pinned spot (reverse lookup), shown so a mismatch with the typed address is visible. */
  pinLabel?: string | null;
  /** A rough device fix: drawn as a circle and zoomed to; the owner taps the entrance inside it. */
  area?: { latitude: number; longitude: number; radius: number } | null;
}

/** Until a pin or detected area exists, open on India (where shops are). Pins anywhere in the world still work. */
const INDIA_CENTER: [number, number] = [22.5, 79];
const INDIA_ZOOM = 4;
/** Below this zoom a tap only zooms in; pins are placed at street level. */
const MIN_PIN_ZOOM = 15;
const PIN_ZOOM = 17;

export default function ShopLocationPicker({
  latitude,
  longitude,
  center,
  onChange,
  pinLabel,
  area,
}: ShopLocationPickerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const areaRef = useRef<L.Circle | null>(null);
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const initial: [number, number] = latitude != null && longitude != null
      ? [latitude, longitude]
      : center
        ? [center.latitude, center.longitude]
        : INDIA_CENTER;
    const map = L.map(containerRef.current, {
      zoomControl: true,
      attributionControl: true,
    }).setView(initial, latitude != null ? 18 : center ? center.zoom ?? 16 : INDIA_ZOOM);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);

    map.on('click', (event: LeafletMouseEvent) => {
      // Zoomed out, a tap is a guess (a stray tap at city level would pin the
      // wrong street): the first tap zooms in on that spot, the next one pins it.
      if (map.getZoom() < MIN_PIN_ZOOM) {
        map.setView(event.latlng, PIN_ZOOM);
        return;
      }
      onChangeRef.current(
        Number(event.latlng.lat.toFixed(6)),
        Number(event.latlng.lng.toFixed(6)),
      );
    });

    mapRef.current = map;
    const resizeTimer = window.setTimeout(() => map.invalidateSize(), 0);

    return () => {
      window.clearTimeout(resizeTimer);
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
      areaRef.current = null;
    };
    // The opening coordinates intentionally define the initial viewport only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!center || !mapRef.current) return;
    mapRef.current.setView([center.latitude, center.longitude], center.zoom ?? 16);
  }, [center]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    areaRef.current?.remove();
    areaRef.current = null;
    if (!area) return;
    const at = L.latLng(area.latitude, area.longitude);
    // Not interactive, so a tap inside the circle still reaches the map and drops the pin.
    areaRef.current = L.circle(at, { radius: area.radius, color: '#2257d9', weight: 1, fillOpacity: 0.1, interactive: false }).addTo(map);
    map.fitBounds(at.toBounds(area.radius * 2), { maxZoom: 17, padding: [12, 12] });
  }, [area]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || latitude == null || longitude == null) return;

    const position: [number, number] = [latitude, longitude];
    if (markerRef.current) {
      markerRef.current.setLatLng(position);
    } else {
      const marker = L.marker(position, {
        draggable: true,
        keyboard: true,
        title: 'Shop entrance pin. Drag to move it.',
        icon: L.divIcon({
          className: 'location-pin-icon',
          html: '<span></span>',
          iconSize: [24, 24],
          iconAnchor: [12, 12],
        }),
      }).addTo(map);
      marker.on('dragend', () => {
        const at = marker.getLatLng();
        onChangeRef.current(Number(at.lat.toFixed(6)), Number(at.lng.toFixed(6)));
      });
      markerRef.current = marker;
    }
    map.panTo(position);
  }, [latitude, longitude]);

  return (
    <div className="location-picker">
      <div className="location-map-wrap">
        <div className="location-map" ref={containerRef} aria-label="Map for selecting the exact shop entrance" />
        <div className="location-map-hint">Tap or click the map, or drag the pin to the exact entrance</div>
      </div>
      <div className="location-pin-readout">
        <div>
          <strong>{latitude != null && longitude != null ? 'Entrance pin selected' : 'No entrance pin yet'}</strong>
          <span title={latitude != null && longitude != null ? `${latitude.toFixed(6)}, ${longitude.toFixed(6)}` : undefined}>
            {latitude != null && longitude != null
              ? pinLabel ? `Near ${pinLabel}` : `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`
              : area
                ? 'Your shop should be inside the blue circle. Tap its entrance, then drag to adjust.'
                : 'Zoom in and tap or click the exact counter or entrance, then drag to adjust.'}
          </span>
        </div>
        <span className={`stamp ${latitude != null && longitude != null ? 'green' : 'yellow'}`}>
          {latitude != null && longitude != null ? 'ready to save' : 'select pin'}
        </span>
      </div>
    </div>
  );
}
