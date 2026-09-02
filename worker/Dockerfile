# Worker image: Node + a FULL ffmpeg (with drawtext/libfreetype) + fonts.
# We install ffmpeg from apt rather than relying on the npm `ffmpeg-static`
# binary, because that prebuilt binary is compiled WITHOUT the drawtext filter
# (no libfreetype) and the title overlay needs it. server.js auto-detects and
# prefers this system ffmpeg. The npm static binaries remain as a fallback.
FROM node:20-slim

# ffmpeg (full build, includes drawtext) + fonts for the title overlay.
# fonts-noto-core provides Noto Sans Gujarati/Devanagari so Indic titles render
# instead of showing empty boxes.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core fonts-noto-core ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=3001
EXPOSE 3001

CMD ["node", "server.js"]
