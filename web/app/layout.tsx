import type { Metadata, Viewport } from 'next'
import { Azeret_Mono } from 'next/font/google'
import './globals.css'

const mono = Azeret_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Glide',
  description: 'Glide turns your phone into a trackpad and keyboard for your Mac.',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Glide',
  },
  other: { 'mobile-web-app-capable': 'yes' },
}

export const viewport: Viewport = {
  themeColor: '#0a0c0f',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={mono.variable}>
      <body>{children}</body>
    </html>
  )
}
