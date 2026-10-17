"use client";
import Image from "next/image";
import { CheckIcon } from "lucide-react";
import { COVER_STYLES, type CoverStyleId } from "@/lib/agent/media/cover-styles";

/** A grid of the predefined cover styles with their previews (public/cover-styles/<id>.jpg). */
export function CoverStylePicker({
  value,
  onChange,
  disabled,
}: {
  value: CoverStyleId;
  onChange: (id: CoverStyleId) => void;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label="Cover style" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {COVER_STYLES.map((style) => {
        const selected = style.id === value;
        return (
          <button
            key={style.id}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(style.id)}
            title={style.description}
            className={`group overflow-hidden rounded-lg border text-left transition disabled:opacity-60 ${
              selected ? "border-foreground ring-2 ring-foreground" : "hover:border-foreground/40"
            }`}
          >
            <span className="relative block">
              <Image
                src={`/cover-styles/${style.id}.jpg`}
                alt={`${style.name} cover style preview`}
                width={480}
                height={270}
                className="aspect-video h-auto w-full object-cover"
              />
              {selected && (
                <span className="absolute top-1.5 right-1.5 rounded-full bg-foreground p-0.5 text-background">
                  <CheckIcon className="size-3.5" />
                </span>
              )}
            </span>
            <span className="block p-2">
              <span className="block text-sm font-medium">{style.name}</span>
              <span className="line-clamp-2 block text-xs text-muted-foreground">{style.description}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
