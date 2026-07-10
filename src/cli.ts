import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { CommandsModule } from './commands/commands.module';
import { RemediateStrandedDataCommand } from './commands/remediate-stranded-data.command';

async function main(): Promise<void> {
  const [commandName, ...args] = process.argv.slice(2);
  const logger = new Logger('CLI');

  if (!commandName || commandName === '--help' || commandName === '-h') {
    printHelp();
    return;
  }

  const app = await NestFactory.createApplicationContext(CommandsModule, {
    logger: ['log', 'warn', 'error'],
  });

  try {
    switch (commandName) {
      case 'remediate-stranded-data': {
        const command = app.get(RemediateStrandedDataCommand);
        const stats = await command.execute(args);
        if (stats.guarantorErrors > 0 || stats.chainErrors > 0) {
          process.exitCode = 1;
        }
        break;
      }
      default:
        logger.error(`Unknown command: ${commandName}`);
        printHelp();
        process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
}

function printHelp(): void {
  console.log(`
Usage:
  npm run cli -- remediate-stranded-data [--dry-run] [--output=./missing-4eyes.json] [--no-synthetic-chains]

Commands:
  remediate-stranded-data   Release rejected-loan guarantor holds and flag/remediate missing 4-eyes chains.
`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
