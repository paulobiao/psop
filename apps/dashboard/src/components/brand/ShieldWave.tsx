interface ShieldWaveProps {
  className?: string;
  size?: number;
  title?: string;
}

export default function ShieldWave({ className, size = 24, title }: ShieldWaveProps) {
  return (
    <svg aria-hidden={title ? undefined : true} aria-label={title} className={className} fill="none" height={size} role={title ? 'img' : undefined} viewBox="0 0 48 48" width={size} xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="shield-wave-orbit" x1="7" y1="6" x2="40" y2="42" gradientUnits="userSpaceOnUse"><stop stopColor="#24d8ff" /><stop offset=".52" stopColor="#287bff" /><stop offset="1" stopColor="#ad58ff" /></linearGradient>
        <filter id="shield-wave-glow"><feGaussianBlur stdDeviation="1.4" /></filter>
      </defs>
      <ellipse cx="24" cy="25" rx="15" ry="12" fill="url(#shield-wave-orbit)" opacity=".2" filter="url(#shield-wave-glow)" />
      <ellipse cx="24" cy="25" rx="15" ry="12" stroke="url(#shield-wave-orbit)" strokeWidth="2.5" />
      <ellipse cx="24" cy="25" rx="20" ry="9" stroke="#34d7ff" strokeOpacity=".78" strokeWidth="1.6" transform="rotate(-38 24 25)" />
      <path d="M15.3 33.8c1.6-8.8 6.4-15.2 15.6-19.7" stroke="#7c65ff" strokeLinecap="round" strokeWidth="2" />
      <path d="m13.4 36.1 4.9-2.1-2.1 4.7" stroke="#54dcff" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" />
      <circle cx="33.2" cy="15.6" r="2.5" fill="#0b2859" stroke="#66e4ff" strokeWidth="1.4" />
      <circle cx="39.5" cy="15.8" r="1.9" fill="#c36fff" />
    </svg>
  );
}
