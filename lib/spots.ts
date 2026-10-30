export type Spot = {
  id: number;
  name: string;
  kind: string;
  availability: string;
  hours: string;
  verified: boolean;
  distanceMeters: number;
  upvotes: number;
  comments: number;
  updated: string;
  lat: number;
  lng: number;
  createdAt: number;
  image?: string;
};

export const initialSpots: Spot[] = [
  {
    id: 1, name: "Maya's Chai Kada", kind: "Chai kada", availability: "Imported only",
    hours: "10:00 AM – 11:00 PM", verified: true, distanceMeters: 300, upvotes: 50, comments: 57,
    updated: "Today", lat: 9.9312, lng: 76.2673, createdAt: 4,
  },
  {
    id: 2, name: "Market Street Mart", kind: "Shop", availability: "Not sure",
    hours: "8:00 AM – 10:00 PM", verified: false, distanceMeters: 450, upvotes: 12, comments: 3,
    updated: "Today", lat: 9.934, lng: 76.269, createdAt: 3,
  },
  {
    id: 3, name: "Waterfront lookout", kind: "Scenic pause", availability: "Imported only",
    hours: "Open all day", verified: true, distanceMeters: 500, upvotes: 34, comments: 8,
    updated: "Yesterday", lat: 9.928, lng: 76.262, createdAt: 2,
  },
  {
    id: 4, name: "Old Harbour Tea Stall", kind: "Chai kada", availability: "Local only",
    hours: "6:00 AM – 12:00 AM", verified: true, distanceMeters: 700, upvotes: 89, comments: 14,
    updated: "2 days ago", lat: 9.925, lng: 76.271, createdAt: 1,
  },
];

export function distanceLabel(distanceMeters: number) {
  return distanceMeters < 1000 ? `${distanceMeters} m` : `${(distanceMeters / 1000).toFixed(1)} km`;
}
