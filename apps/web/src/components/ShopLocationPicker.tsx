import { useEffect, useRef } from 'react';
import L, { type LeafletMouseEvent } from 'leaflet';
import 'leaflet/dist/leaflet.css';

interface ShopLocationPickerProps {
  latitude: number | null;
  longitude: number | null;
  center: { latitude: number; longitude: number; zoom?: number } | null;
  onChange: (latitude: number, longitude: number) => void;
}

const INDIA_CENTER: [number, number] = [22.9734, 78.6569];

export default function ShopLocationPicker({
  latitude,
  longitude,
  center,
  onChange,
}: ShopLocationPickerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.CircleMarker | null>(null);
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
    }).setView(initial, latitude != null ? 18 : center?.zoom ?? 16);

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
      markerRef.current = L.circleMarker(position, {
        radius: 9,
        color: '#ffffff',
        weight: 3,
        fillColor: '#2257d9',
        fillOpacity: 1,
      }).addTo(map);
    }
    map.panTo(position);
  }, [latitude, longitude]);

  return (
    <div className="location-picker">
      <div className="location-map-wrap">
        <div className="location-map" ref={containerRef} aria-label="Map for selecting the exact shop entrance" />
        <div className="location-map-hint">Click the exact shop entrance</div>
      </div>
      <div className="location-pin-readout">
        <div>
          <strong>{latitude != null && longitude != null ? 'Entrance pin selected' : 'No entrance pin yet'}</strong>
          <span>
            {latitude != null && longitude != null
              ? `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`
              : 'Zoom in and click the exact counter or entrance.'}
          </span>
        </div>
        <span className={`stamp ${latitude != null && longitude != null ? 'green' : 'yellow'}`}>
          {latitude != null && longitude != null ? 'ready to save' : 'select pin'}
        </span>
      </div>
    </div>
  );
}
