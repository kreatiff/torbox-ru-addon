const VIDEO_EXTENSIONS = new Set([
  'mp4',
  'mkv',
  'ts',
  'avi',
  'webm',
  'mov',
  'wmv',
  'm4v',
  'flv',
  'mpg',
  'mpeg',
]);

export function isVideoFile(path: string): boolean {
  const match = /\.([a-z0-9]+)$/i.exec(path);
  if (!match?.[1]) {
    return false;
  }
  return VIDEO_EXTENSIONS.has(match[1].toLowerCase());
}
