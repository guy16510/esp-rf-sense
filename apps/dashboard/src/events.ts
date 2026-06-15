export interface TimelineEvent {
  id: number;
  type: string;
  label: string;
  groupId: string;
  timestamp: number;
}

export class EventStore {
  private readonly values: TimelineEvent[] = [];
  private sequence = 0;

  add(type: string, label: string, groupId: string, timestamp: number): TimelineEvent {
    const value = {
      id: ++this.sequence,
      type: type.slice(0, 40),
      label: label.slice(0, 120),
      groupId: groupId.slice(0, 120),
      timestamp,
    };
    this.values.push(value);
    if (this.values.length > 500) this.values.shift();
    return value;
  }

  list(): TimelineEvent[] {
    return [...this.values];
  }
}
