import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "quirqy | open-chat — a little room for your files",
  description: "A read-only view of your local workspace. Powered by files, shaped like OpenMuse."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
