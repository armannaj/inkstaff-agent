/**
 * Featured image styles to choose from, per product (Writing settings) or per cover (editor). Each is a visual spec
 * the image model follows; the headline, a topic motif drawn in the style's own technique, and the crop-safe layout
 * rules are added by featuredImagePrompt. Previews live in public/cover-styles/<id>.jpg. `imagery` is the same look for
 * in-article illustrations and infographics, so every image in an article matches its cover.
 */
export const COVER_STYLES = [
  {
    id: "ink-marker",
    name: "Ink & Marker",
    description: "Warm off-white paper, loose orange brush strokes and doodles, bold serif headline.",
    spec: "Background: warm off-white paper with a faint texture. Decoration: loose, energetic hand-drawn marks in one warm orange/amber (dry-brush strokes, swooshes, small arrows, starbursts, dots, scribbled circles) clustered toward the corners and edges, leaving the center clean. Headline: very large, bold, high-contrast black serif (editorial, like a modern Didone or Tiempos Headline), tight leading. Mood: lively, handmade, confident.",
    motif: "at most one small topic doodle in the same orange marker line",
    imagery: "Hand-drawn editorial illustration on warm off-white textured paper: confident loose black ink linework with energetic dry-brush accents in one warm orange/amber, a few doodled arrows, dots or swooshes, and plenty of empty paper. Palette: off-white, black ink, orange only.",
  },
  {
    id: "editorial-serif",
    name: "Editorial Serif",
    description: "Cream magazine cover, elegant serif headline, fine line art in deep green.",
    spec: "Background: soft cream (#F4EFE6) with a subtle paper grain. Typography: a large, refined high-contrast serif headline in near-black (like Canela or GT Super), with one short thin forest-green rule centered above it. Decoration: one elegant, fairly large line illustration in deep forest green (#1F4D3A), like a fine pen drawing in a literary magazine, below or beside the headline block, never overlapping the text. Mood: calm, intelligent, premium print magazine.",
    motif: "the line illustration depicts the topic, drawn as a fine green pen drawing",
    imagery: "Refined editorial line illustration on soft cream paper: fine near-black and forest-green pen lines with light cross-hatching and generous empty space. Palette: cream, near-black, deep green. Calm and magazine-like.",
  },
  {
    id: "bold-gradient",
    name: "Bold Gradient",
    description: "Rich violet-to-coral gradient, big white geometric headline, subtle grain.",
    spec: "Background: a rich, smooth mesh gradient from deep violet (#4B2BD6) through magenta to warm coral (#FF7A59), with fine film grain and soft glowing light. Typography: very large, heavy white geometric sans-serif headline in Title Case (like Satoshi or General Sans Bold), tight tracking and tight leading, lines of similar length. Decoration: two or three soft translucent frosted-glass rounded shapes floating near the edges, partly cropped by the frame. Mood: modern SaaS launch, energetic and polished.",
    motif: "one frosted-glass shape contains a simple glowing 3D icon of the topic",
    imagery: "Polished modern illustration on a smooth deep-violet-to-coral mesh gradient with fine film grain and soft glowing light: frosted-glass shapes and simple glowing 3D objects. Palette: violet, magenta, coral, white.",
  },
  {
    id: "paper-cutout",
    name: "Paper Cutout",
    description: "Layered paper-cut shapes in soft pastels with gentle shadows and a friendly sans headline.",
    spec: "Background: layered paper-cut shapes in a soft pastel palette (sage, peach, butter yellow, powder blue) with real paper texture and gentle drop shadows between layers, forming rolling organic shapes around the edges. Typography: large, friendly rounded sans-serif headline in deep charcoal, set directly on the light center of the paper layers. Everything, including any object, is cut from the same colored paper with the same shadows: no emoji, clip art or flat icons. Mood: warm, crafted, approachable.",
    motif: "one paper-cut object related to the topic, cut from the same pastel papers, sitting among the layers near an edge",
    imagery: "Layered paper-cut illustration: every object and background cut from soft pastel paper (sage, peach, butter yellow, powder blue) with real paper texture and gentle shadows between the layers. Warm and crafted.",
  },
  {
    id: "risograph",
    name: "Risograph",
    description: "Two-color riso print in fluorescent pink and blue, halftone and grain, playful bold type.",
    spec: "Look of a two-color risograph print on off-white paper, using only fluorescent pink (#FF48B0) and federal blue (#3255A4) with visible overprint where they overlap, halftone dots, slight misregistration and ink grain. Typography: huge, bold, slightly quirky grotesque headline in blue. Decoration: simple bold shapes and halftone patterns in pink near the edges. Mood: indie, playful, zine.",
    motif: "one simple bold shape in the print suggests the topic",
    imagery: "Two-color risograph print on off-white paper: only fluorescent pink and federal blue, with overprint where they overlap, halftone dots, slight misregistration and ink grain. Bold simple shapes, playful zine mood.",
  },
  {
    id: "blueprint",
    name: "Blueprint",
    description: "Deep navy blueprint grid, white technical line drawings, clean condensed headline.",
    spec: "Background: deep blueprint navy (#0F2A4A) with a fine light-blue grid and faint measurement marks. Decoration: crisp white technical line drawings (thin lines, dimension arrows and tick marks, no written annotations) near the edges. Typography: very large, clean white condensed sans-serif headline in Title Case (like Barlow Condensed SemiBold). Mood: precise, technical, engineering notebook.",
    motif: "a white technical schematic of the topic near one edge",
    imagery: "Technical blueprint drawing: crisp white line art on deep blueprint navy with a fine light-blue grid, dimension arrows and tick marks. Precise, engineering-notebook mood.",
  },
  {
    id: "swiss-minimal",
    name: "Swiss Minimal",
    description: "White canvas, huge black grotesk headline, one bold red block, strict grid.",
    spec: "International Typographic Style. Background: pure white. Typography: very large black neo-grotesk headline (like Helvetica Now Display Bold), flush-left within a centered text block, tight leading. Decoration: exactly one solid signal-red (#E4312B) circle or rectangle and at most two thin black rules, aligned to a strict grid and kept away from the headline. No other color and no other marks. Mood: minimal, bold, design-literate.",
    motif: "no illustration; the single red shape is the only graphic element",
    imagery: "Minimal International Typographic Style graphic: pure white ground, black geometric forms and thin rules, one signal-red accent, strict grid and lots of white space. No other colors.",
  },
  {
    id: "watercolor",
    name: "Watercolor Wash",
    description: "Soft watercolor washes in muted blues and terracotta around a graceful serif headline.",
    spec: "Background: textured cold-press watercolor paper. Decoration: soft, loose watercolor washes and blooms in muted dusty blue, terracotta and sand, bleeding gently from the edges and corners, with a few fine ink splatters. Typography: large, graceful dark-ink serif headline in the clean center. Mood: calm, human, artful.",
    motif: "a loose watercolor sketch of the topic near one edge",
    imagery: "Loose watercolor illustration on textured cold-press paper: soft washes and blooms in muted dusty blue, terracotta and sand, with fine dark-ink accents and a few splatters. Calm and human.",
  },
] as const;

export type CoverStyle = (typeof COVER_STYLES)[number];
export type CoverStyleId = CoverStyle["id"];
export const COVER_STYLE_IDS = COVER_STYLES.map((s) => s.id) as [CoverStyleId, ...CoverStyleId[]];
export const DEFAULT_COVER_STYLE: CoverStyleId = "ink-marker";

export function coverStyle(id: string | undefined): CoverStyle {
  return COVER_STYLES.find((s) => s.id === id) ?? COVER_STYLES.find((s) => s.id === DEFAULT_COVER_STYLE)!;
}
