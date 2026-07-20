import { ImageResponse } from "@takumi-rs/image-response";
import { appName } from "./shared";

export const docsOgImageSize = { height: 630, width: 1200 } as const;

export type DocsOgImageContent = {
  title: string;
  description: string;
};

export function renderDocsOgImage(content: DocsOgImageContent): ImageResponse {
  return new ImageResponse(<DocsOgArtwork content={content} />, {
    ...docsOgImageSize,
    format: "webp",
    headers: {
      "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
    },
  });
}

function DocsOgArtwork({ content }: { content: DocsOgImageContent }) {
  return (
    <div
      style={{
        backgroundColor: "#f7f1e7",
        color: "#20241d",
        display: "flex",
        fontFamily: "monospace",
        height: "100%",
        overflow: "hidden",
        position: "relative",
        width: "100%",
      }}
    >
      <div
        style={{
          backgroundColor: "#eff4d4",
          borderRadius: 999,
          bottom: -420,
          height: 720,
          opacity: 0.68,
          position: "absolute",
          right: -300,
          width: 720,
        }}
      />

      <main
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100%",
          padding: "54px 72px 48px",
          position: "relative",
          width: "100%",
        }}
      >
        <header style={{ alignItems: "center", display: "flex" }}>
          <PiprMark />
          <div
            style={{
              color: "#4f5649",
              display: "flex",
              fontSize: 14,
              fontWeight: 700,
              letterSpacing: 1.8,
              marginLeft: 14,
              textTransform: "uppercase",
            }}
          >
            {appName} Docs
          </div>
        </header>

        <section
          style={{
            display: "flex",
            flex: 1,
            flexDirection: "column",
            justifyContent: "center",
            maxWidth: 980,
            paddingBottom: 18,
          }}
        >
          <div
            style={{
              display: "flex",
              fontSize: 70,
              fontWeight: 700,
              letterSpacing: -3,
              lineHeight: 1.02,
              maxWidth: 980,
            }}
          >
            {content.title}
          </div>
          <div
            style={{
              color: "#4d5249",
              display: "flex",
              fontSize: 29,
              lineHeight: 1.4,
              marginTop: 30,
              maxWidth: 920,
            }}
          >
            {content.description}
          </div>
        </section>

        <footer
          style={{
            alignItems: "center",
            color: "#666b61",
            display: "flex",
            fontSize: 12,
            letterSpacing: 0.8,
          }}
        >
          <div
            style={{
              backgroundColor: "#a9ce4f",
              display: "flex",
              height: 8,
              marginRight: 12,
              width: 8,
            }}
          />
          <div style={{ display: "flex" }}>Your code. Your models. Your policy.</div>
          <div style={{ color: "#8a8e85", display: "flex", marginLeft: 18 }}>pipr.run</div>
        </footer>
      </main>
    </div>
  );
}

function PiprMark() {
  return (
    <svg height="38" viewBox="0 0 150 150" width="38">
      <title>Pipr mark</title>
      <path
        d="m87 3.6h-31c-22.7 0-44.8 17.5-44.8 39.2v104.1h13.9v-101.9c0.1-13.1 12.5-27 28.6-27.1h33.3c17.3 0 37.3 13.3 37.7 42.1 0 18.2-10.9 30.9-17.7 36.2-5.6 4.2-12.9 7.4-21.5 7.6h-19.2l-15.6 15.1 35-0.1c24.1 0.1 52.9-18.8 53-58 0-25.6-18.7-57.2-51.7-57.2z"
        fill="#2d3526"
      />
      <path
        d="m86.4 34.2h-24.9c-10.4 0-21.4 9.2-21.4 20v53.8l18.9-16.5c1.5-1.4 3.9-3.1 6.5-3.1h19.5c14.3 0 24.8-12.2 24.7-27.2 0-14-9.7-26.7-23.3-27zm-4.3 41.8h-17.2c-3.8 0.1-5.9 1.8-7.3 3.2l-5.8 4.9v-24.6c0-6.5 5.4-14.1 13.9-14.1h16.8c7.4 0 14.3 5.9 14.3 14.5s-5.9 16.1-14.7 16.1z"
        fill="#b8d85e"
      />
    </svg>
  );
}
