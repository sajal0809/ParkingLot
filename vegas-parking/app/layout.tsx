import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Park Vegas | Reserve your parking spot",
  description: "Choose your exact parking spot at Gardens Galleria. Customer reservations and operator parking management.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
