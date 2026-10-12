import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NeuroLens · 脑瘤影像识别分类系统",
  description: "本地脑瘤影像识别分类案例。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
