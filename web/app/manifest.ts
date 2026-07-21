import type { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Glide',
    short_name: 'Glide',
    description: 'Glide turns your phone into a trackpad and keyboard for your Mac.',
    start_url: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0a0c0f',
    theme_color: '#0a0c0f',
  }
}
