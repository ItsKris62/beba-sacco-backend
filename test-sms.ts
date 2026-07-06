import { NestFactory } from '@nestjs/core';
import { AppModule } from './src/app.module';
import { SmsService } from './src/modules/sms/sms.service';
import { Logger } from '@nestjs/common';

async function bootstrap() {
  const logger = new Logger('TestSMS');
  const app = await NestFactory.createApplicationContext(AppModule);
  
  const smsService = app.get(SmsService);
  logger.log('SmsService resolved successfully.');

  try {
    // We are testing formatPhoneE164
    const phone = '0712345678';
    const formatted = smsService.formatPhoneE164(phone);
    logger.log(`Phone ${phone} formatted to: ${formatted}`);

    // Let's test the SMS dispatch (this will use environment variables)
    // To avoid actually sending an SMS (which costs money and needs a real number), 
    // we can either mock AfricasTalking or just test the formatting.
    // If we want to test delivery, we could send it to a test number or an invalid number.
    // We'll just call sendSms with an invalid test number to see how it handles it,
    // or test if the credentials are present in ConfigService.

    const sent = await smsService.sendSms('+254700000000', 'Test SMS from audit script');
    logger.log(`SMS send attempt result: ${sent}`);
  } catch (err) {
    logger.error('Error testing SMS:', err);
  }

  await app.close();
}

bootstrap();
