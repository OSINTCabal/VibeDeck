/** Rows of Mistral's pixel "M", top to bottom: colour and [column, width] runs. */
const ROWS: [string, [number, number][]][] = [
  ["#FFAF01", [[1, 1], [5, 1]]],
  ["#FF8204", [[1, 2], [4, 2]]],
  ["#FA500F", [[1, 5]]],
  ["#E51300", [[1, 1], [3, 1], [5, 1]]],
  ["#C4001D", [[0, 3], [4, 3]]],
];

/**
 * Mistral's pixel mark, drawn in the official gradient (yellow to red, top
 * to bottom) as the brand guidelines prefer. `mono` renders it in one colour
 * from the `fill-*` class instead, for use on a coloured badge.
 */
export function MistralLogo({
  size = 24, className, mono = false,
}: {
  size?: number;
  className?: string;
  mono?: boolean;
}) {
  return (
    <svg
      width={size}
      height={Math.round(size * (5 / 7))}
      viewBox="0 0 7 5"
      xmlns="http://www.w3.org/2000/svg"
      shapeRendering="crispEdges"
      role="img"
      aria-label="Mistral"
      className={className}
    >
      {ROWS.flatMap(([color, runs], y) => runs.map(([x, width]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width={width} height={1} fill={mono ? undefined : color} />
      )))}
    </svg>
  );
}
