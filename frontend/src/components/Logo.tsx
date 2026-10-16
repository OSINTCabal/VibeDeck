/**
 * Mistral's pixel mark in the orange used by Vibe's web interface.
 */
export function MistralLogo({
  size = 24, className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={Math.round(size * (130 / 182))}
      viewBox="26 26 182 130"
      fill="#FF4A00"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Mistral"
      className={className}
    >
      <rect x="52" y="26" width="26" height="26" />
      <rect x="156" y="26" width="26" height="26" />
      <rect x="52" y="52" width="52" height="26" />
      <rect x="130" y="52" width="52" height="26" />
      <rect x="52" y="78" width="130" height="26" />
      <rect x="52" y="104" width="26" height="26" />
      <rect x="104" y="104" width="26" height="26" />
      <rect x="156" y="104" width="26" height="26" />
      <rect x="26" y="130" width="78" height="26" />
      <rect x="130" y="130" width="78" height="26" />
    </svg>
  );
}
