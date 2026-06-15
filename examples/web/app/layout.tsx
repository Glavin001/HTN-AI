import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "htn-ai — Staircase World",
  description:
    "Browser preview of the htn-ai real-time planner: an agent discovers how to stack blocks into a staircase to reach a 3D coordinate up in the air.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
