import * as React from 'react';
import { Box, Text } from '../../ink.js';

const F = '\x1b[38;2;255;85;60m'
const B = '\x1b[48;2;255;85;60m'
const E = '\x1b[48;2;255;85;60m\x1b[30m'
const R = '\x1b[0m'
const ART_LINES = [
  `  ${B}          ${R}`,
  ` ${F}▄${R}${B}  ${R} ${B}    ${R} ${B}  ${R}${F}▄${R}`,
  ` ${F}▀${R}${B}    ${E}▄▄${B}    ${R}${F}▀${R}`,
  `   ${F}▀ ▀  ▀ ▀${R}`,
]

export function Clawd() {
  return (
    <Box flexDirection="column">
      {ART_LINES.map(line => (
        <Text key={line}>
          {line}
        </Text>
      ))}
    </Box>
  );
}
