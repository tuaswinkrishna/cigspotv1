"use client";

import { useEffect } from "react";
import { MapContainer, Marker, Popup, TileLayer, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import { Clock3, MessageCircle, ShieldCheck, ThumbsUp } from "lucide-react";
import type { Spot } from "@/lib/spots";
import { distanceLabel } from "@/lib/spots";

type Coordinates = { lat: number; lng: number };

type SpotMapProps = {
  spots: Spot[];
  onChooseSpot: (spot: Spot) => void;
  onAddAt: (coordinates: Coordinates) => void;
};

function ClickToAdd({ onAddAt }: { onAddAt: SpotMapProps["onAddAt"] }) {
  useMapEvents({
    click(event) {
      onAddAt({ lat: event.latlng.lat, lng: event.latlng.lng });
    },
  });
  return null;
}

function ResizeMap() {
  const map = useMap();
  useEffect(() => {
    const timer = window.setTimeout(() => map.invalidateSize(), 180);
    return () => window.clearTimeout(timer);
  }, [map]);
  return null;
}

function spotIcon(spot: Spot) {
  return L.divIcon({
    className: `spot-marker${spot.verified ? "" : " spot-marker--unverified"}`,
    html: `<div class="spot-marker__pill"><span>${spot.id}</span></div>`,
    iconSize: [42, 38],
    iconAnchor: [15, 34],
    popupAnchor: [5, -30],
  });
}

export default function SpotMap({ spots, onChooseSpot, onAddAt }: SpotMapProps) {
  return (
    <MapContainer center={[9.9312, 76.2673]} zoom={14} scrollWheelZoom className="z-0">
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <ClickToAdd onAddAt={onAddAt} />
      <ResizeMap />
      {spots.map((spot) => (
        <Marker
          key={spot.id}
          position={[spot.lat, spot.lng]}
          icon={spotIcon(spot)}
        >
          <Popup>
            <div className="w-[230px] overflow-hidden rounded-2xl bg-white">
              <div className={`spot-art spot-art--${spot.kind === "Chai kada" ? "tea" : spot.kind === "Shop" ? "shop" : "view"} h-[102px]`}>
                {spot.image && <img src={spot.image} alt="" className="spot-art__image" />}
                <span className="spot-art__label">{spot.kind}</span>
              </div>
              <div className="p-3.5">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="text-[14px] font-bold leading-tight">{spot.name}</h3>
                    <p className="mt-1 text-[11px] text-[#747b73]">{spot.availability} · {distanceLabel(spot.distanceMeters)} away</p>
                  </div>
                  {spot.verified && <ShieldCheck size={16} className="mt-0.5 shrink-0 text-[#3f684b]" />}
                </div>
                <div className="mt-2.5 flex items-center gap-3 text-[10px] text-[#747b73]">
                  <span className="flex items-center gap-1"><Clock3 size={12} />{spot.hours}</span>
                </div>
                <div className="mt-3 flex items-center justify-between border-t border-[#eff0eb] pt-2.5 text-[11px] text-[#626a63]">
                  <span className="flex items-center gap-1"><ThumbsUp size={12} />{spot.upvotes} helpful</span>
                  <span className="flex items-center gap-1"><MessageCircle size={12} />{spot.comments}</span>
                  <button onClick={() => onChooseSpot(spot)} className="font-bold text-[#3f684b]">Details</button>
                </div>
              </div>
            </div>
          </Popup>
        </Marker>
      ))}
    </MapContainer>
  );
}
