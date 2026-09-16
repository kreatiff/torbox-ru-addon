import React from 'react';

// Majority-script homoglyph detector and renderer
export function highlightHomoglyphs(name: string): React.ReactNode {
  // Split name by word boundaries to run token-based analysis
  const tokens = name.split(/([^a-zA-Zа-яА-ЯёЁ0-9])/);

  return (
    <>
      {tokens.map((token, idx) => {
        if (!token || /^[0-9\W_]+$/.test(token)) {
          return <span key={idx}>{token}</span>;
        }

        let latinCount = 0;
        let cyrillicCount = 0;

        for (let i = 0; i < token.length; i++) {
          const code = token.charCodeAt(i);
          if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
            latinCount++;
          } else if (code >= 0x0400 && code <= 0x04ff) {
            // Full Cyrillic block; U+0401 (Ё) and U+0451 (ё) are inside this range already.
            cyrillicCount++;
          }
        }

        if (latinCount === 0 || cyrillicCount === 0) {
          return <span key={idx}>{token}</span>;
        }

        const isPredominantlyLatin = latinCount >= cyrillicCount;
        const chars = [];

        for (let i = 0; i < token.length; i++) {
          const char = token[i]!;
          const code = token.charCodeAt(i);
          const isCyrillic = code >= 0x0400 && code <= 0x04ff;
          const isLatin = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
          const isMinority =
            (isPredominantlyLatin && isCyrillic) || (!isPredominantlyLatin && isLatin);

          if (isMinority) {
            const hex = 'U+' + code.toString(16).toUpperCase().padStart(4, '0');
            const scriptName = isCyrillic ? 'CYRILLIC' : 'LATIN';
            const tooltip = `${char} (${hex} ${scriptName})`;
            chars.push(
              <span key={i} className="homoglyph-char" data-tooltip={tooltip}>
                {char}
              </span>,
            );
          } else {
            chars.push(char);
          }
        }

        return <span key={idx}>{chars}</span>;
      })}
    </>
  );
}

// X из Y title parser
export function parseXizY(name: string) {
  const clean = name.replace(/Ё/g, 'Е').replace(/ё/g, 'е');
  // Match "8 из 13"
  const singleMatch = clean.match(/(\d+)\s*(?:из|iz|u3)\s*(\d+)/i);
  if (singleMatch) {
    return {
      x: parseInt(singleMatch[1]!, 10),
      y: parseInt(singleMatch[2]!, 10),
    };
  }
  // Match range "01-16 из 16"
  const rangeMatch = clean.match(/(\d+)-(\d+)\s*(?:из|iz|u3)\s*(\d+)/i);
  if (rangeMatch) {
    const a = parseInt(rangeMatch[1]!, 10);
    const b = parseInt(rangeMatch[2]!, 10);
    return {
      x: b - a + 1,
      y: parseInt(rangeMatch[3]!, 10),
    };
  }
  return null;
}

// Format bytes helper
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
