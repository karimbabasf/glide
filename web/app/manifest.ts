import type { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Phone Mouse',
    short_name: 'Mouse',
    description: 'Turns this phone into a wireless trackpad for your Mac.',
    start_url: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0a0c0f',
    theme_color: '#0a0c0f',
  }
}
