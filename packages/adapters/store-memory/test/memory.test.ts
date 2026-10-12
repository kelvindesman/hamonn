import { describeStoreContract } from "@hamonn/contract";
import { MemoryStore } from "../src/index.ts";

describeStoreContract("memory", async () => ({ store: new MemoryStore() }));
