import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  googleMapsAvailable, loadMapKit, markGoogleMapsFailed, subscribeGoogleMaps,
  type GoogleMap, type GoogleMarker, type MapKit,
} from '../lib/googleMaps.js';
import { INDIA_CENTER, INDIA_ZOOM, MIN_PIN_ZOOM, PIN_ZOOM, type LocationMapProps } from './locationMap.js';

/** False once Google failed to load or refused the key; the location UI then falls back to Leaflet. */
export function useGoogleMaps(): boolean {
  return useSyncExternalStore(subscribeGoogleMaps, googleMapsAvailable, googleMapsAvailable);
}

const round6 = (value: number) => Number(value.toFixed(6));

/** Google Maps version of the shop pin map: same props and rules as the Leaflet one. */
export default function GoogleLocationMap({ latitude, longitude, center, area, onChange }: LocationMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState<{ kit: MapKit; map: GoogleMap } | null>(null);
  const markerRef = useRef<GoogleMarker | null>(null);
  const latest = useRef({ latitude, longitude, center, onChange });
  latest.current = { latitude, longitude, center, onChange };

  useEffect(() => {
    let cancelled = false;
    loadMapKit().then((kit) => {
      if (cancelled || !containerRef.current) return;
      // The opening view comes from the props at the moment the map exists.
      const { latitude: lat, longitude: lng, center: view } = latest.current;
      const map = new kit.Map(containerRef.current, {
        center: lat != null && lng != null
          ? { lat, lng }
          : view ? { lat: view.latitude, lng: view.longitude } : { lat: INDIA_CENTER[0], lng: INDIA_CENTER[1] },
        zoom: lat != null ? 18 : view ? view.zoom ?? 16 : INDIA_ZOOM,
        clickableIcons: false, // a tap on a shop/temple icon places the pin instead of opening Google's card
        zoomControl: true, // plain +/- buttons: desktop scroll-zoom needs Ctrl inside a scrolling page
        cameraControl: false,
        streetViewControl: false,
        fullscreenControl: false,
        mapTypeControlOptions: { position: kit.ControlPosition.LEFT_BOTTOM },
      });
      map.addListener('click', (event) => {
        if (!event.latLng) return;
        // Zoomed out, a tap is a guess: the first tap zooms in on that spot, the next one pins it.
        if ((map.getZoom() ?? 0) < MIN_PIN_ZOOM) {
          map.setCenter(event.latLng);
          map.setZoom(PIN_ZOOM);
          return;
        }
        latest.current.onChange(round6(event.latLng.lat()), round6(event.latLng.lng()));
      });
      setReady({ kit, map });
    }, () => {
      if (!cancelled) markGoogleMapsFailed();
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!ready || !center) return;
    ready.map.setCenter({ lat: center.latitude, lng: center.longitude });
    ready.map.setZoom(center.zoom ?? 16);
  }, [ready, center]);

  useEffect(() => {
    if (!ready || !area) return;
    // Not clickable, so a tap inside the circle still reaches the map and drops the pin.
    const circle = new ready.kit.Circle({
      map: ready.map,
      center: { lat: area.latitude, lng: area.longitude },
      radius: area.radius,
      strokeColor: '#2257d9',
      strokeWeight: 1,
      fillColor: '#2257d9',
      fillOpacity: 0.1,
      clickable: false,
    });
    const bounds = circle.getBounds();
    if (bounds) ready.map.fitBounds(bounds, 12);
    return () => circle.setMap(null);
  }, [ready, area]);

  useEffect(() => {
    if (!ready || latitude == null || longitude == null) return;
    const position = { lat: latitude, lng: longitude };
    if (markerRef.current) {
      markerRef.current.setPosition(position);
    } else {
      const marker = new ready.kit.Marker({
        map: ready.map,
        position,
        draggable: true,
        title: 'Shop entrance pin. Drag to move it.',
      });
      marker.addListener('dragend', (event) => {
        if (event.latLng) latest.current.onChange(round6(event.latLng.lat()), round6(event.latLng.lng()));
      });
      markerRef.current = marker;
    }
    ready.map.panTo(position);
  }, [ready, latitude, longitude]);

  return (
    <>
      <div className="location-map" ref={containerRef} aria-label="Map for selecting the exact shop entrance" />
      {!ready && <div className="location-map-loading" aria-hidden>Loading map…</div>}
    </>
  );
}
