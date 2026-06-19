import { readFile } from 'node:fs/promises';

export interface RecordedPositionFrame {
  firstWordInvalid: boolean;
  csiBase64: string;
}

export interface RecordedPositionDatagram {
  deviceId: number;
  frames: RecordedPositionFrame[];
}

export async function readRecordedPositionDatagrams(
  path: string,
): Promise<RecordedPositionDatagram[]> {
  const text = await readFile(path, 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RecordedPositionDatagram);
}
