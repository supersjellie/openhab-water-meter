/*
  Water Meter pulse counter

  It counts pulses (usually for 1 litre) generated by a NPN proximity sensor on a water meter (0=ON) and sends info over serial (USB)

  Every 10 seconds it will sent a simple message with '[v1,v2,v2,...]'
  - (0) loopSpeed : microseconds used for 1 loop = CPU usage.
  - (1) totalCount : counted pulses since running (can be adjusted) = watermeter total in m3
  - (2) 10secCount: pulses in 10 seconds = actual measured waterflow last 10 seconds
  - (3) pulseSpeed: 1000*pulses/minute  = waterflow in ml/min. Only if pulse come in steady flow/ i.e. within (default) 3 minutes 
  - (4) mintotal: (running) sum of pulses in last minute = litres of water used last minute 
  - (5) lasttotal: total sum of last series of pulses =  litres of water using in last run (can be 1 and never erased)
  - (6) pulse:(last) pulse before this message.
  - (7) total time of last series of pulses
  - (8) state: calibration state
 
  When calibrating (see commands), the message is extended with "calibrating",time 0,time 1, count
  - (9) time 0: Time in msec for a 0
  - (10) time 1: Time in msec for a 1
  - (11) count: consistent timings (when 10 is reached calibration is done)

  Where calbration is done or is requested (see commands), the message is extended with "(un)calibrated",pulse 0, pulse 1
  - (9) part/fraction of pulse 0 : 0-accurancy (sum parts is accurancy) 
  - (10) part/fraction of pulse 1 : 0-accurancy (sum parts is accurancy) 
  - (11) 0 : dummy for count

  Default an NPN sensor is assumed, so 0 when making contact and only this state change is counted.
  If the sensor is placed in a way it's on/off half the time (when running) the accurancy can be doubled bij counting both 
  statechanges (so also to the 1). It will make approximally 2 pulses every cycle. And improving accurancy to 0.5 litre and half the 'response time'.
  Turn on a steady flow of water and issue the command 'calibrate'. If times are steady it will average 5 pulses and use that for calibration for
  an in between value. Even if the calibration changes the only problem is the in between value. It will always count 1 litre for a full cycle.

  When uncalibrated it's easy. All variables are in litres, so no trouble with rounding. If you calibrate, the first half might be 0.4242 and the
  second half 0.5768. So for a full turn it's still 1, but you also get an in between. So rounding issues can occur or steady flows might be 
  reported as a bit more or less. That's where de accurancy comes in. Default accurancy is 10.000, meaning 1 pulse/litre is stored as 10.000. Same for
  calibration timings and so on. This will make storing the 0.5 litre possible. To prevent fake accurancy, the output never reports more than 
  0.1 litre for totals and 1 ml for flow. The latter is where you need it, since the flow is derived from time between pulses. The 10.000 matches the
  input. Think 1 litre a minute, so (calibrated) 0.5 litre in 30 seconds. So the timing for is 30.000 ms, in the order of the 10.000. The numbers for
  the total are now too big for a long, so that's why a totalCountH/L exsists. The H contains the full litres. The L the fraction 'accurancy' part.

  Using Serial/USB input commands can be send:
  - calibrate: this starts the calibration. Output will extend with both timings and a counter. When it's done it shows the values for both parts.
  - P0:value: enter the valiue for the first half (the 0). Sets P1 with remainder/other part
  - P1:value: enter the value for the second half (the 1). Sets P0 with remainder/other part
  - T:value enter the value for the total (to set current watermeter total)

  While operation the build-in led will blink every second, when pulses are detected twice as fast. When arduino boots it's something in between.

  Depending on your usecase the pulseTreshold value is important. This is a treshold (in millisec) that determines a continious stream of pulses (water)
  or seperate uses. So for example it will reset flow and lastTotal values when a pulse exceeds this timeOut. Default it's three minutes.
  
  No floats, so remember 3/2=1 (and not 1.5 rounded up to 2). So (3+1)/2 is rounded option. Same for (15+5)/10

 */

 const bool DEBUG=false;

//clock & running speed
long clock=millis();
int loopCount=0;//count loops
long loopTime=clock;//last calculation of speed
long speed=-1L;//microsecs per loop

//sending info over USB
long reportDelay=clock;//last reportmoment

//led blink 
int ledSpeed=1000;//default blink speed
bool ledOn=false;//led state

//input pulse over D2 (normal=HIGH) wth debounce/jitter correction
bool pulseInit=true;//ignore first pulse (init loop/detector)
int pulsePin = 2;//digital pin for pulse sensor, 2 = D2
bool pulseDetect=false;//is pulse detected (on 0 or if double accurancy on both 0 and 1)
long accurancy=10000L;//1 pulse/litre = default 1000
long totalCountH=0L;//total pulses since run (default accurancy=1). Number part
long totalCountL=0L;//total pulses since run (default accurancy=1). Fraction part
long lastTotal=0L;//total of (last) series of pulses (default accurancy=1)
long lastTotalTime=-1L;//total of (last) series of pulses (default accurancy=1)
long lastTotalTemp=0L; //calc total of (last) series of pulses (default accurancy=1)
long minCount[]={0L,0L,0L,0L,0L,0L};// lastTotal for 6 periods (default accurancy=1)
long pulseCount = 0L;//pulses in last 10 sec period (default accurancy=1)
int pulseLast=1;//last pulse value
int pulse=1;//current pulse value
long pulseTime = 0L;// last pulse value change time
long pulseDelay = 100L;//minimal time between value changes
long pulseSet=0L;// last time pulse set(0=ON for NPN detector)
long pulseSpeed=0L;//pulserate*1000/min i.e. flowrate in ml/min (assuming standard pulse set for 1 litre)
long pulseTreshold=180000L;//maximum time between pulses to calculate/reset pulseSpeed
long pulseTimeOut=pulseTreshold;//timeout/reset for current pulseSpeed (assumes same speed to continue)

//double accurancy (by using pulse on/off as a trigger)
bool calibrated=false;//calibrated (so active)
long pulseTime0=0L;//calibrated time for 0 (0-accurancy)
long pulseTime1=0L;//calibrated time for 1 (0-accurancy)
bool calibrating=false;//calibrating now
bool calibrationDone=false;//calibration just finished, report results
int pulseStable=0;//count on stable pulses (10 needed for calibration)
long pulseTime0T=0L;//sum while calibrating for 0
long pulseTime1T=0L;//sum while calibrating for 1
int maxBuffer=0;

void setup() {

  //init serial
  Serial.begin(9600);

  //wait for serial active
  while(!Serial){
    delay(100);
  }

  maxBuffer=Serial.availableForWrite();

  //init led
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, LOW);

  //init pulse input
  pinMode(pulsePin, INPUT_PULLUP); 
  digitalWrite(pulsePin, HIGH);
}

void loop() {

  //synch clock
  clock=millis();

  //main parts of program
  loopSpeed();
  procesPulse();
  serialWrite();
  ledBlink();
  serialInput();

}




/*
  count 10.000 loops to get the speed of a loop.
*/
void loopSpeed(){

  //count and store time it takes to perform 10.000 loops
  loopCount++;
  if (loopCount>10000L){
    loopCount=0L;
    //convert millisec for 10.000 loops to microsecond for 1 loop (so 1.000/10.000)
    speed=(clock-loopTime)/10L;
    loopTime=clock;
  }

}

/*
  detect a pulse and translate it to total pulses, pulsespeed, minute count, last count etc
*/
void procesPulse(){

  //detect pulse
  pulse=digitalRead(pulsePin);
  if (pulse != pulseLast){
    //change
    if (clock-pulseTime>pulseDelay){
      //enough time past (debouncing state changes)
      pulseLast=pulse;
      pulseDetect=true;

      //check if in calibration mode, if so get timings
      if (calibrating && pulse==0){
        //check stable times for 0
        if (abs(clock-pulseTime-pulseTime0)<200L){
          pulseStable++;
        }else {
          pulseStable=0;
          pulseTime0T=0L;
          pulseTime1T=0L;
        }
        //keep pulsetime
        pulseTime0=clock-pulseTime;
        pulseTime0T+=clock-pulseTime;
      }else if (calibrating && pulse==1) {
        //check stable times for 1
        if (abs(clock-pulseTime-pulseTime1)<200L){
          pulseStable++;
        }else {
          pulseStable=0;
          pulseTime0T=0L;
          pulseTime1T=0L;
        }
        //keep pulsetime;
        pulseTime1=clock-pulseTime;
        pulseTime1T+=clock-pulseTime;
      }

      //process/calculate pulses, don't proces startup pulse
      if (!pulseInit){

        //default only on 0 (a=1000), else get part 0 or 1
        long a=accurancy;
        if (calibrated && pulse==0){
          a=pulseTime0T;
        }else if (calibrated && pulse==1){
          a=pulseTime1T;
        }


        //flow calculation, default only on full-pulse. When calibrated also on half-pulse
        if (pulse==0 || calibrated){

          //increase count (remember longs are truncated when divided). 
          pulseCount+=a;
          lastTotalTemp+=a;

          //split totaLCount in two longs (it won't fit in 1 long). 
          totalCountL+=a;
          totalCountH+=totalCountL / accurancy;
          totalCountL=totalCountL % accurancy;



          //if we have constant pulse rate, calculate pulseSpeed
          if (pulseSet>0 && (clock-pulseSet)<=pulseTreshold){
            //below treshold, calc 1000*pulseSpeed/min (ie ml/min)
            pulseSpeed=60000000L/(clock-pulseSet);

            //next pulse should arrive within 150% time of current pulse 
            pulseTimeOut=(clock-pulseSet)*15L/10L;

          } else {
            //above treshold, assume no constant rate. Just on/off's
            pulseSpeed=0L;
            pulseTimeOut=pulseTreshold;

          }

          //remember set time for next pulse
          pulseSet=clock;

        }

        //calculated for full cycle, if calibrated correct for half pulses.
        if (calibrated){
          //correct for calibrated half pulses
          pulseSpeed=(pulseSpeed*a+accurancy/2L)/accurancy;

          //timeout is for next/other half. So assume current is calibrated at 250, the next one is 750. And expected next pulse will take 750/250=3 time as long.
          pulseTimeOut=pulseTimeOut*(accurancy-a)/a;
        }

        //don't exceed maximum timehout
        if (pulseTimeOut>pulseTreshold){
          pulseTimeOut=pulseTreshold;
        }

      }

      //reset bounce/jitter clock/init
      pulseInit=false;
      pulseTime=clock;

    }
  }

  if ((clock-pulseSet)>pulseTimeOut){
    //Over treshold, reset speed
    pulseSpeed=0L;
  }

  if ((clock-pulseSet)>pulseTimeOut*3L && lastTotalTemp>0L){
    //over lastTotal treshold and we got a new value, keep it and reset
    lastTotal=lastTotalTemp;
    lastTotalTime=clock;
    lastTotalTemp=0L;
  }

  if (clock-lastTotalTime>86400000L){
    //more than a day, reset
    lastTotalTime=-1L;
  }


}

/*
  Write results to Serial (every 10 seconds). Between [] so listener can check for complete messages
*/
void serialWrite(){
  //10 seconds passed OR every pulse when calibrating
  if ((!calibrating && clock-reportDelay>10000L) || (calibrating && pulseDetect)){
    //send/proces state

    //reset delay
    reportDelay=clock;

    //check serial/usb connected
    int bytes=Serial.availableForWrite();
    debug(F("buffer "),bytes);
    bool serialOk=(bytes==maxBuffer);
    
    if (!calibrating){
      //normal operation, shift 6 (x 10 sec= 1 min) values
      for (int i=0;i<5;i++){
        minCount[i]=minCount[i+1];
      }
      //and current value
      minCount[5]=pulseCount;
    }

    //sum periods to get minute value
    long minTotal=0L;
    for (int i=0;i<6;i++){
      minTotal+=minCount[i];
    }


    if (serialOk){
      //standard first message part 
      Serial.flush();
      Serial.print('[');
      Serial.print(speed);//(0) loopSpeed
      Serial.print(',');
      //(1) totalCount : combine numbers in single string 
      Serial.print(totalCountH);
      long tmp=(10L*totalCountL+5L*accurancy/10L)/accurancy;// So 5678 is (56780 + 5000)/10000 = 61780/10000 = 6 (floored). So printed .6  
      Serial.print('.');  
      Serial.print(tmp); //0.6 (with privious 12345 is 12345.6)  
      Serial.print(',');    
      Serial.print(round(10.0*pulseCount/accurancy)/10.0);//(2) 10secCount
      Serial.print(',');    
      Serial.print(pulseSpeed);//(3) pulseSpeed
      Serial.print(',');    
      Serial.print(round(10.0*minTotal/accurancy)/10.0);//(4) mintotal
      Serial.print(',');    
      Serial.print(round(10.0*lastTotal/accurancy)/10.0);//(5) lasttotal
      Serial.print(',');    
      Serial.print(pulse);//(6) pulse
      Serial.print(',');    
      if (lastTotalTime<0){
        Serial.print('0');    
      }else {
        Serial.print( (clock-lastTotalTime+30000L)/60000L);
      }
    }
    
    //reset period
    pulseCount=0;
    pulseDetect=false;

    //finish calibrating?
    if (calibrating){

      if (pulseStable>=9){

        //get average for 0 and 1 timings
        pulseStable++;
        pulseStable/=2;
        pulseTime0T/=pulseStable;
        pulseTime1T/=pulseStable;

        //finish and report
        calibrationDone=true;
      }

      //proces calibration?
      if (calibrationDone){

        //check calibration
        long n=pulseTime0T+pulseTime1T;
        if (n!=0 && n!=accurancy && pulseTime0T>0L && pulseTime1T>0L){
          //new values, normalize to 0-accurancy

          //force rounding of long
          n*=10L;
          pulseTime0T=accurancy*(pulseTime0T*10L+5L)/n;
          pulseTime1T=accurancy*(pulseTime1T*10L+5L)/n;
          n=accurancy;

        }

        if (n==accurancy){
          //calibrating correct, reset
          calibrating=false;
          calibrated=true;
          pulseStable=0;
        }
      }
    }

    if (serialOk){
      //report second part
      Serial.print(',');

      if (calibrating){
        Serial.print(F("calibrating"));
      }else if (!calibrated){    
        Serial.print(F("uncalibrated"));
      } else {
        Serial.print(F("calibrated"));
      }  
      Serial.print(',');
      if (calibrating){    
        //current timing
        Serial.print(pulseTime0);
        Serial.print(',');    
        Serial.print(pulseTime1);
      } else {
        //calibration setting
        Serial.print(pulseTime0T);
        Serial.print(',');    
        Serial.print(pulseTime1T);
      }
      Serial.print(',');    

      if (calibrating){
        Serial.print(pulseStable);
      } else {
        Serial.print('0');
      }

      Serial.println(']');
    } 

  }

}

/*
  Blink Led slow or fast
*/
void ledBlink(){
  //change to fast blinking when pulses within last 10 sec
  if (pulseTime>0 && clock-pulseTime<10000L){
    //recent pulses, blink fast
    ledSpeed=500;
  }else {
    //just running, no water usage
    ledSpeed=1000;
  }

  //blink led
  if ((clock/ledSpeed % 2)==0 && ledOn){
    //even second, led on
    digitalWrite(LED_BUILTIN, LOW);
    ledOn=false;
  } else if ((clock/ledSpeed % 2)==1 && !ledOn){
    //odd second, led off
    digitalWrite(LED_BUILTIN, HIGH);
    ledOn=true;
  }

}

/*
  process commands thought Serial
  CALIBRATE, CALIBRATION, P0:number, P1:number, T:number
*/
void serialInput(){


  //get serial input
  if (Serial.available()>0){
    //input available, so command given
    String input=Serial.readString();

    //check for available commands
    if (input.startsWith(F("CALIBRATE"))){
      //reset and start calibration
      calibrated=false;
      calibrating=true;
      calibrationDone=false;
      pulseStable=0;
      pulseTime0T=0L;
      pulseTime1T=0L;
    } else if (input.startsWith(F("P0:"))){
      //set 0 part
      input=input.substring(3);
      int v=input.toInt();
      if(v>0 && v<accurancy){
        //valid
        pulseTime0T=v;
        pulseTime1T=accurancy-v;
        calibrated=true;
      }
    } else if (input.startsWith(F("P1:"))){
      //set 1 part
      input=input.substring(3);
      int v=input.toInt();
      if(v>0 && v<accurancy){
        //valid
        pulseTime0T=accurancy-v;
        pulseTime1T=v;
        calibrated=true;
      }
    } else if (input.startsWith(F("T:"))){
      //set total
      input=input.substring(2);
      long value=0L+input.toInt();
      if (value>=0){
        totalCountH=value;
        totalCountL=0;
      }
    }
  }
}

void debug(const __FlashStringHelper* txt){
  if (DEBUG){
    Serial.println(txt);
  }
}

void debug(const __FlashStringHelper* txt,int nr){
  if (DEBUG){
    Serial.print(txt);
    Serial.println(nr);
  }
}