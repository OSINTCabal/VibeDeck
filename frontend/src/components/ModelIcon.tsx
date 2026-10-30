import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { MistralLogo } from "./Logo";

// Mistral models carry the pixel mark, tinted by tier (large → small, like
// Mistral's own orange-to-yellow ramp); other families get their own mark.
const MISTRAL_TINTS: [RegExp, string][] = [
  [/large|magistral-medium/, "fill-[#FF4A00]"],
  [/devstral|codestral/, "fill-[#FA6B1E]"],
  [/medium/, "fill-[#FF8205]"],
  [/small|magistral/, "fill-[#FFAF00]"],
  [/ministral|tiny|nemo/, "fill-[#FFD800]"],
];

function PixelGlm({ size }: { size: number }) {
  // a 4x4 pixel lattice in GLM's blue
  const cells = [[1, 0], [2, 0], [0, 1], [3, 1], [1, 2], [2, 2], [0, 3], [3, 3], [1, 1], [2, 3]];
  return (
    <svg width={size} height={size} viewBox="0 0 4 4" role="img" aria-label="GLM" shapeRendering="crispEdges">
      {cells.map(([x, y]) => <rect key={`${x}${y}`} x={x} y={y} width="1" height="1" className={(x + y) % 2 ? "fill-[#2563EB]" : "fill-[#60A5FA]"} />)}
    </svg>
  );
}

export function ModelIcon({ id, size = 14, className }: { id: string; size?: number; className?: string }) {
  const key = (id || "").toLowerCase();
  let icon: React.ReactNode;
  if (/glm|zai|zhipu/.test(key)) icon = <PixelGlm size={size - 2} />;
  else if (/mistral|stral|ministral|pixtral|nemo/.test(key)) {
    const tint = MISTRAL_TINTS.find(([re]) => re.test(key))?.[1] || "fill-[#FF4A00]";
    icon = <MistralLogo size={size} className={tint} />;
  } else icon = <Sparkles size={size - 2} className="text-text-muted" />;
  return <span className={cn("grid shrink-0 place-items-center", className)} style={{ width: size, height: size }}>{icon}</span>;
}
