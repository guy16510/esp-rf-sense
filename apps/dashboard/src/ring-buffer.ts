export class RingBuffer<T> {
  private readonly values: T[] = [];

  constructor(private readonly capacity: number) {}

  get length(): number {
    return this.values.length;
  }

  push(value: T): void {
    this.values.push(value);
    if (this.values.length > this.capacity) this.values.shift();
  }

  recent(limit: number): T[] {
    return this.values.slice(-limit);
  }

  clear(): void {
    this.values.length = 0;
  }
}
