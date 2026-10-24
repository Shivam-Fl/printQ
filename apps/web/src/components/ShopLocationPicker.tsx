import { useEffect, useRef } from 'react';
import L, { type LeafletMouseEvent } from 'leaflet';
import 'leaflet/dist/leaflet.css';

interface ShopLocationPickerProps {
  latitude: number | null;
  longitude: number | null;
  center: { latitude: number; longitude: number; zoom?: number } | null;
  onChange: (latitude: number, longitude: number) => void;
}

/** No country assumed: until a pin or detected area exists, show the whole world. */
const WORLD_CENTER: [number, number] = [20, 0];

export default function ShopLocationPicker({
  latitude,
  longitude,
  center,
  onChange,
}: ShopLocationPickerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
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
        : WORLD_CENTER;
    const map = L.map(containerRef.current, {
      zoomControl: true,
      attributionControl: true,
    }).setView(initial, latitude != null ? 18 : center ? center.zoom ?? 16 : 2);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);

    map.on('click', (event: LeafletMouseEvent) => {
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
        <div className="location-map-hint">Click the map or drag the pin to the exact entrance</div>
      </div>
      <div className="location-pin-readout">
        <div>
          <strong>{latitude != null && longitude != null ? 'Entrance pin selected' : 'No entrance pin yet'}</strong>
          <span>
            {latitude != null && longitude != null
              ? `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`
              : 'Zoom in and click the exact counter or entrance, then drag to adjust.'}
          </span>
        </div>
        <span className={`stamp ${latitude != null && longitude != null ? 'green' : 'yellow'}`}>
          {latitude != null && longitude != null ? 'ready to save' : 'select pin'}
        </span>
      </div>
    </div>
  );
}
