const puppeteer = require('puppeteer');
const {parseISO, compareAsc, isBefore, format} = require('date-fns')
require('dotenv').config();
const dateFns = require('date-fns');

const {delay, sendEmail, logStep} = require('./utils');
const {siteInfo, loginCred, IS_PROD, NEXT_SCHEDULE_POLL, MAX_NUMBER_OF_POLL, NOTIFY_ON_DATE_BEFORE} = require('./config');

let isLoggedIn = false;
let maxTries = MAX_NUMBER_OF_POLL
let tries = 0;
let foundDates = [];

const login = async (page) => {
  logStep('logging in');
  await page.setExtraHTTPHeaders({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/85.0.4183.121 Safari/537.36'
  });
  await page.goto(siteInfo.LOGIN_URL, { waitUntil: 'networkidle2' });

  // Wait for the form to be loaded with an increased timeout
  await page.waitForSelector("form#sign_in_form", { timeout: 60000 });

  const form = await page.$("form#sign_in_form");

  if (!form) {
    throw new Error('Login form not found');
  }

  const email = await form.$('input[name="user[email]"]');
  const password = await form.$('input[name="user[password]"]');
  const privacyTerms = await form.$('input[name="policy_confirmed"]');
  const signInButton = await form.$('input[name="commit"]');

  if (!email || !password || !privacyTerms || !signInButton) {
    throw new Error('One of the form elements was not found');
  }

  await email.type(loginCred.EMAIL);
  await password.type(loginCred.PASSWORD);
  await privacyTerms.click();
  await signInButton.click();

  await page.waitForNavigation({ waitUntil: 'networkidle2' });
  console.log("Login done")
  return true;
}

const notifyMe = async (earliestDate) => {
  const formattedDate = format(earliestDate, 'dd-MMMM-yyyy');
  logStep(`sending an email to schedule for ${formattedDate}`);
  await sendEmail({
    subject: `We found an earlier date ${formattedDate}`,
    text: `Hurry and schedule for ${formattedDate} before it is taken. Go to the appointments page here: ${siteInfo.LOGIN_URL}`
  })
}

const checkForSchedules = async (page) => {
  logStep('checking for schedules');
  await page.setExtraHTTPHeaders({
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'X-Requested-With': 'XMLHttpRequest',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/85.0.4183.121 Safari/537.36'
  });
  await page.goto(siteInfo.APPOINTMENTS_JSON_URL);

  const originalPageContent = await page.content();
  const bodyText = await page.evaluate(() => {
    return document.querySelector('body').innerText
  });

  try{
    console.log(bodyText);
    const parsedBody =  JSON.parse(bodyText);

    if(!Array.isArray(parsedBody)) {
      throw "Failed to parse dates, probably because you are not logged in";
    }

    const dates = parsedBody.map(item => parseISO(item.date));
    const [earliest] = dates.sort(compareAsc);

    return earliest;
  }catch(err){
    console.log("Unable to parse page JSON content", originalPageContent);
    console.error(err);
    isLoggedIn = false;
  }
}

const checkForFirstAvailableDateFromPaymentsPages = async (page) => {
  logStep('Checking for first available date from payments page');

  // Set extra HTTP headers
  await page.setExtraHTTPHeaders({
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
    'X-Requested-With': 'XMLHttpRequest',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/85.0.4183.121 Safari/537.36'
  });

  try {
    // Navigate to the payments page
    await page.goto(siteInfo.PAYMENTS_URL, { waitUntil: 'networkidle2' });
    
    // Log the page content
    const pageContent = await page.content();
    console.log(pageContent);

    const dateElement = await page.$('table.for-layout tr:first-child td:nth-child(2)');

    if (!dateElement) {
      throw new Error("Date element not found on the payments page");
    }

    // Extract the date text from the page
    const date = await dateElement.evaluate(el => el.innerText);

    // Parse and return the date
    if (date && date !== 'No Appointments Available') {
      let dateText = dateFns.parse(date, 'dd MMMM, yyyy', new Date());
      dateText = dateFns.format(dateText, 'dd-MMMM-yyyy');
      logStep(`Found date ${dateText}`);
      return new Date(dateText);
    } else if (date === 'No Appointments Available') {
      logStep('No appointments available');
      return null;
    } else {
      throw new Error("Couldn't find the expected date on the payments page");
    }
  } catch (err) {
    console.log("Unable to parse page content", await page.content());
    console.error(err);
    isLoggedIn = false;
  }
};

const process = async (browser) => {
  logStep(`starting process with ${maxTries} tries left`);

  if(maxTries-- <= 0){
    console.log('Reached Max tries')
    return
  }

  const page = await browser.newPage();

  if(!isLoggedIn) {
     isLoggedIn = await login(page);
  }

  const earliestDate = await checkForSchedules(page);
  if(earliestDate && isBefore(earliestDate, parseISO(NOTIFY_ON_DATE_BEFORE))){
    await notifyMe(earliestDate);
  }

  let n = 0;
  while (n < NEXT_SCHEDULE_POLL) {
    n+=10;
    await delay(10000);
    console.log(n);
  }

  await process(browser)
}


(async () => {
  const browser = await puppeteer.launch(!IS_PROD ? {headless: false}: undefined);

  try{
    await process(browser);
  }catch(err){
    console.error(err);
  }

  await browser.close();
})();
