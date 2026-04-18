import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TA Procurement Intelligence",
  description: "Live supply chain and commodity risk signals for Tentang Anak",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
