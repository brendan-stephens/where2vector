import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "where2vector — vector storage latency benchmark",
  description: "pgvector inline vs TOASTed vs Supabase Vector Buckets",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
