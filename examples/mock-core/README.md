# Mock Core Example

This is a simple in-memory mock implementation of the Metis storage core, intended for development, testing, and demonstration purposes.

## Prerequisites

- [Node.js](https://nodejs.org/) (v18 or newer recommended)
- [pnpm](https://pnpm.io/) (the package manager used in this project)

## Setup

1. **Install dependencies**

   From the `examples/mock-core` directory, run:

   ```sh
   pnpm install
   ```

2. **Build (optional)**

   The project is written in TypeScript, but for development and demo purposes, you can run it directly without building. If you want to build the project, run:

   ```sh
   pnpm run build
   ```

## Running the Demo

There are several scripts available:

- **Start the development server:**

  ```sh
  pnpm dev
  ```

  This will start the mock core server using [tsx](https://github.com/esbuild/tsx) for live TypeScript execution.

- **Run the basic demo script:**

  ```sh
  pnpm demo
  ```

- **Run the extended demo script:**

  ```sh
  pnpm demo:extended
  ```

## Project Structure

- `src/` - Source code for the in-memory mock core server.
- `scripts/` - Demo scripts to interact with the mock core.
- `tsconfig.json` - TypeScript configuration for this example.

## Notes

- This project is for demonstration and development only. It does **not** persist any data.
- If you encounter issues, ensure you are using `pnpm` and not `npm` or `yarn`.

## License

MIT
