# cleanheap

This project cleans weak retainer paths from heap snapshots of even the largest most gnarly dumps 💩

✨ Leaving Your Memory Leak Debugging

## Usage

To use:

```bash
npx cleanheap <input-file-path>
```

Optionally:

```bash
npx cleanheap <input-file-path> <output-file-path>
```

## Contributing

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run src/index.ts
```

To compile:

```bash
bun build src/index.ts --outfile bin/cleanheap
```

## Credits

This project was created using `bun init` in bun v0.7.1. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.

Inspired by [dnachev/heapdump-cleanup](https://github.com/dnachev/heapdump-cleanup) I used to use but which couldn't
handle larger heap snapshots.