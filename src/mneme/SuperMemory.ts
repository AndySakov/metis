import { Context } from "effect"
import type Supermemory from "supermemory"

export class SuperMemory extends Context.Tag("mneme/SuperMemory")<SuperMemory, {
  client: Supermemory
}>() {}
