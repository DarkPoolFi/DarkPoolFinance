export function pageMeta(title: string, description: string, socialImage?: string) {
  return {
    meta: [
      { title },
      { name: "description", content: description },
      { property: "og:title", content: title },
      { property: "og:description", content: description },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      ...(socialImage
        ? [
            { property: "og:image", content: socialImage },
            { name: "twitter:image", content: socialImage },
          ]
        : []),
    ],
  };
}
