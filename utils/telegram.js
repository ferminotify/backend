import pool from '../db.js'; 

export async function getTelegramTemporaryCode() {
  /**
   * This function returns the code that
   * the user has to send to telegram bot.
   * 
   * When the bot get this code, register the 
   * telegram user id of the sender (my user).
   * 
   * This code is unique for every subscriber,
   * is generated with a $ at its beginning
   * and parts of the hashed email of the user.
   */
  let code = "X";

  code += (Math.random() + 1).toString(36).substring(6); // add random string of 7 char

  /**
   * VALIDATING CODE
   * Check if the code generated
   * is not yet associated with someone else.
   */
  const allCodes = await getAllTelegram();
  if (allCodes != undefined){
    for(let i=0; i<allCodes.length;i++){
      if(allCodes[i] == code) {
        return getTelegramTemporaryCode();
      }
    }
  }
  return code;
}

async function getAllTelegram() {
  try {
    const RES = await pool.query(
      `SELECT telegram FROM subscribers;`
    );
    return RES.rows[0].telegram;
  } catch (err) {
    console.error(err.stack);
  }
}