interface BrandProps {
  size?: 'sm' | 'lg';
}

export function Brand({ size = 'sm' }: BrandProps) {
  const cls = size === 'lg' ? 'text-3xl sm:text-4xl tracking-[0.42em]' : 'text-sm sm:text-base tracking-[0.38em]';
  return (
    <span className={`select-none font-semibold text-mist-100 ${cls}`}>
      OUR<span className="text-accent">CINEMA</span>
    </span>
  );
}
