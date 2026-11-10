export class EventEmitter2 {
  emit(..._args: any[]) {
    return true;
  }
  on(..._args: any[]) {
    return this;
  }
}

export class EventEmitterModule {
  static forRoot(..._args: any[]) {
    return {
      module: EventEmitterModule,
      providers: [EventEmitter2],
      exports: [EventEmitter2],
    };
  }
}
