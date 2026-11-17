import { Buffer } from 'buffer';

const g = globalThis as unknown as {
  Buffer?: typeof Buffer;
  global?: typeof globalThis;
};

if (!g.Buffer) {
  g.Buffer = Buffer;
}

if (!g.global) {
  g.global = globalThis;
}
