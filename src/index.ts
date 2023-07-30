import chalk from 'chalk';
import pkg from '../package.json';
import { heapStats } from "bun:jsc";
import { HeapSnapshot } from './-types';
import type { BunFile } from 'bun';
import { log } from 'console';

function formatBytes(bytes: number) {
    if (bytes < 1024) {
        return `${bytes}B`;
    } else if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(2)}KB`;
    } else if (bytes < 1024 * 1024 * 1024) {
        return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
    } else {
        return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`;
    }
}

function logMemory() {
    const {
        heapSize,
        heapCapacity,
        extraMemorySize,
        objectCount
    } = heapStats();

    console.log(chalk.grey(`\t${chalk.white('·')}\t\tMemory: ${chalk.cyan(formatBytes(heapSize))} / ${chalk.cyan(formatBytes(heapCapacity))} (${chalk.cyan(formatBytes(extraMemorySize))} extra) - ${chalk.cyan(objectCount)} objects`));
}

function clearLine() {
    // @ts-expect-error not typed properly
    process.stdout.clearLine(0);
    // @ts-expect-error not typed properly
    process.stdout.cursorTo(0);
}

function logUpdate(str: string) {
    clearLine();

    process.stdout.write(str);
}

function logCompletion(str: string) {
    clearLine();

    console.log(str);
}

async function getInput(filePath: string): Promise<HeapSnapshot> {
    const fileHandle = Bun.file(filePath, { type: 'application/json' });
    const exists = await fileHandle.exists();

    if (!exists) {
        console.log(chalk.red(`\tThe file ${chalk.white(filePath)} does not exist!\n`));
        process.exit(1);
    }

    process.stdout.write(chalk.grey(`\t${chalk.white('·')}\t🔸 ...loading Snapshot`));
    const data = await fileHandle.json<HeapSnapshot>();

    logCompletion(chalk.grey(`\t${chalk.white('·')}\t${chalk.green('▶')} Snapshot loaded`));

    return data;
}

async function getOutputFile(filePath: string) {
    const fileHandle = Bun.file(filePath, { type: "application/json" });
    const exists = await fileHandle.exists();

    if (exists) {
        console.log(chalk.yellow(`\t⚠️  Overwriting existing file ${chalk.white(filePath)}!\n`));
    }

    return fileHandle;
}

const WeakRetainerNames = new Set([
    'WeakMap',
    'WeakSet',
    'WeakRef',
    'DebugWeakCache',
    'DebugWeakMap'
]);


class Snapshot {
    declare data: HeapSnapshot;
    declare nodeOffsets: Record<string, number>;
    declare edgeOffsets: Record<string, number>;
    declare nodeTypeEnum: string[];
    declare edgeTypeEnum: string[];

    constructor(data: HeapSnapshot) {
        const meta = data.snapshot.meta;

        this.data = data;
        this.nodeOffsets = fieldOffsets(meta.node_fields);
        this.edgeOffsets = fieldOffsets(meta.edge_fields);
        this.nodeTypeEnum = meta.node_types[this.nodeOffsets.type] as string[];
        this.edgeTypeEnum = meta.edge_types[this.edgeOffsets.type] as string[];
    }

    clean() {
        let nextEdgeIndex = 0;
        let totalObjects = 0;
        let weakRetainers = 0;

        const nodes = this.data.nodes;
        const nodeFields = this.data.snapshot.meta.node_fields;
        const fieldSliceSize = nodeFields.length;
        const edgeCount = this.data.snapshot.edge_count;
        const edgeFieldsCount = this.data.snapshot.meta.edge_fields.length;
        const data = this.data;

        // first pass, null any edges that are weak retainers
        iterateBySlice(
            0,
            nodes.length,
            fieldSliceSize,
            (startOffset: number, endOffset: number) => {
                const start = nextEdgeIndex
                const ownedEdgeCount = getField(nodes, startOffset, edgeCount);
                nextEdgeIndex = nextEdgeIndex + ownedEdgeCount + edgeFieldsCount;
                totalObjects++;

                const nodeName = getNodeName(this, startOffset);
                if (!nodeName || !WeakRetainerNames.has(nodeName)) {
                    return;
                }

                weakRetainers++;

                cleanupRetainers(data, edgeCount, startOffset, start, nextEdgeIndex, edgeFieldsCount);
            }
        );

        // second pass, remove any edges that are null
        this.data.edges = this.data.edges.filter((v: number | null) => v !== null);;

        if (weakRetainers > 0) {
            logCompletion(chalk.grey(`\t${chalk.white('·')}\t\t${chalk.green('▶')} Removed ${chalk.magenta(weakRetainers)} of ${chalk.magenta(totalObjects)} total traversed.`));
        }
        return Boolean(weakRetainers > 0);
    }
}

function cleanupRetainers(data: HeapSnapshot, edgeCount: number, startOffset: number, start: number, nextEdgeIndex: number, edgeFieldsCount: number) {
    const { edges, nodes } = data;

    iterateBySlice(start, nextEdgeIndex, edgeFieldsCount, (edgeStart, edgeEnd) => {
        // remove the edge
        for (let i = edgeStart; i < edgeEnd; i++) {
            edges[i] = null as unknown as number;
        }
        // adjust the edge count
        data.snapshot.edge_count--;
        // adjust the node edge count
        nodes[startOffset + edgeCount]--;
    });
}

function fieldOffsets(fields: string[]) {
    return Object.fromEntries(fields.map((field, offset) => [field, offset]));
  }

function getNodeName(wrapper: Snapshot, nodeIndex: number): string | null {
    const { nodes, strings } = wrapper.data;

    // if the node represents an object, its name will be the type (constructor name really)
    const type = wrapper.nodeTypeEnum[nodes[nodeIndex + wrapper.nodeOffsets.type]];

    if (type !== 'object') {
      return null;
    }

    return strings[nodes[nodeIndex + wrapper.nodeOffsets.name]];
  }

function getField(nodes: number[], offset: number, index: number): number {
    return nodes[offset + index];
}

/**
 * Allows us to iterate a large array in chunks
 * of a predefined size without allocating a new
 * array for each chunk.
 */
function iterateBySlice(
    start: number, // usually 0
    end: number, // usually objects.length
    sliceSize: number,
    callback: (start: number, end: number) => void,
) {
    for (let i = start; i < end; i += sliceSize) {
        callback(i, i + sliceSize);
    }
}

async function writeOutput(outputFile: BunFile, data: HeapSnapshot) {
    const writer = outputFile.writer();
    
    // write the header
    process.stdout.write(chalk.grey(`\t${chalk.white('·')}\t\t🔸 ...writing Snapshot header`));
    let content = JSON.stringify(data.snapshot);
    data.snapshot = null as unknown as any;
    writer.write(`{ "meta": ${content},`);
    writer.flush();
    content = ''; // free up memory
    Bun.gc(true);
    logCompletion(chalk.grey(`\t${chalk.white('·')}\t\t${chalk.green('▶')} Snapshot Headers`));
    logMemory();

    // write the nodes
    process.stdout.write(chalk.grey(`\t${chalk.white('·')}\t\t🔸 ...writing Snapshot nodes`));
    content = JSON.stringify(data.nodes);
    data.nodes = null as unknown as any;
    writer.write(`"nodes": ${content},`);
    writer.flush();
    content = ''; // free up memory
    Bun.gc(true);
    logCompletion(chalk.grey(`\t${chalk.white('·')}\t\t${chalk.green('▶')} Snapshot nodes`));
    logMemory();

    // write the edges
    process.stdout.write(chalk.grey(`\t${chalk.white('·')}\t\t🔸 ...writing Snapshot edges`));
    content = JSON.stringify(data.edges);
    data.edges = null as unknown as any;
    writer.write(`"edges": ${content}}`);
    writer.flush();
    content = ''; // free up memory
    Bun.gc(true);
    logCompletion(chalk.grey(`\t${chalk.white('·')}\t\t${chalk.green('▶')} Snapshot edges`));
    logMemory();

    // write the strings
    process.stdout.write(chalk.grey(`\t${chalk.white('·')}\t\t🔸 ...writing Snapshot strings`));
    content = JSON.stringify(data.strings);
    data.strings = null as unknown as any;
    writer.write(`"strings": ${content}}`);
    writer.flush();
    content = ''; // free up memory
    Bun.gc(true);
    logCompletion(chalk.grey(`\t${chalk.white('·')}\t\t${chalk.green('▶')} Snapshot strings`));
    logMemory();

    // write everything else
    process.stdout.write(chalk.grey(`\t${chalk.white('·')}\t\t🔸 ...writing Snapshot Infos`));
    for (const key in data) {
        if (key === 'snapshot' || key === 'nodes' || key === 'edges' || key === 'strings') {
            continue;
        }
        content = JSON.stringify(data[key]);
        data[key] = null as unknown as any;
        writer.write(`"${key}": ${content},`);
        writer.flush();
        content = ''; // free up memory
        Bun.gc(true);
    }
    logCompletion(chalk.grey(`\t${chalk.white('·')}\t\t${chalk.green('▶')} Snapshot Infos`));
    logMemory();

    // close the file
    writer.end();
    console.log(chalk.grey(`\t${chalk.white('·')}\t${chalk.green('▶')} Snapshot written`));
    logMemory();

    // we're done!
    console.log(chalk.magenta(`\n\t✨ Sparkling Clean\n\n`));
}



async function main() {
    const inputFilePath = Bun.argv[2];
    const outputFilePath = Bun.argv[3] || inputFilePath.replace(/\.heapsnapshot$/, '.clean.heapsnapshot');
    
    console.log(
        chalk.grey(`\n\n\t✨ CleanHeap ${chalk.green('v' + pkg.version)}\n\t====================\n\n`) +
        chalk.grey(`\tReading ${chalk.green('▶')} ${chalk.yellow(inputFilePath)}\n`) +
        chalk.grey(`\tWriting ${chalk.green('▶')} ${chalk.yellow(outputFilePath)}\n\n`) +
        chalk.magenta(`\t🧹 Cleaning HeapSnapshot edges of Weak Retainers\n\n`)
    );

    const writeHandler = await getOutputFile(outputFilePath);
    const data = await getInput(inputFilePath);
    logMemory();

    process.stdout.write(chalk.grey(`\t${chalk.white('·')}\t🔸 ...parsing Snapshot`));
    const snapshot = new Snapshot(data);
    logCompletion(chalk.grey(`\t${chalk.white('·')}\t${chalk.green('▶')} Snapshot parsed`));
    logMemory();

    process.stdout.write(chalk.grey(`\t${chalk.white('·')}\t🔸 ...cleaning Snapshot`));
    const isDirty = snapshot.clean();

    if (!isDirty) {
        logCompletion(chalk.grey(`\t${chalk.white('·')}\t${chalk.green('▶')} Snapshot Was Already Clean`));
        console.log(chalk.magenta(`\n\t✨ Sparkling Clean\n\n`));
    } else {
        logCompletion(chalk.grey(`\t${chalk.white('·')}\t${chalk.green('▶')} Snapshot cleaned`));
        logMemory();

        return await writeOutput(writeHandler, snapshot.data);
    }

}

await main();