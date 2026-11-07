/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Public Google Maps browser key (HTTP-referrer + API restricted in Google Cloud). Set: the shop
   * location map, address search and pin lookup use Google. Unset: Leaflet + the API geocoder.
   */
  readonly VITE_GOOGLE_MAPS_API_KEY?: string;
}
