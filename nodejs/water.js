/*
 * Watermeter service
 * - Arduino program USB data to JSON service script
 * - Keeps P0/P1/Total consistant over Arduino watermeter, this program and openHAB
 * - Optional keep state on disk (reuse on powerloss/reset/update)
 * - Optional read openHAB water total (resuse on powerloss/reset/update)
 * - Optional auto init calibration (when uncalibrated)
 
 * Edit vars below for your configuration.
 *
 * This script provides 6 services (when connected to Arduino watermeter):
 * http://localhost/water : JSON with actual readout of (Arduino) water meter
 * http://localhost/p0/value: set P0 period (0-10000). P0+P1=10000!
 * http://localhost/p1/value: set P1 period (0-10000). P0+P1=10000!
 * http://localhost/total/value: set total value in litres (so 1234567 is 1234,567 m3)
 * http://localhost/total/calibrate: start calibration
 * 
 * V0.9 - Added powerfail/reset/update recovery
 * V0.8 - Added half litre calibration/setup
 * V0.7 - Basic setup for writing watermeter
 * V0.6 - Basic setup for reading watermeter
 */

const DEBUG=false; //debug logging on/off
const PORT = 3002; //port of webservice

//when AUTO_INIT=true send this calibration to arduino on startup
const AUTO_INIT=true;//send calibration on startup
const MY_P0=5226;//default is disk values, when empty/0/missing this value will be used if >0 (and become disk value)
const MY_P1=4774;//default is disk values, when empty/0/missing this value will be used if >0 (and become disk value)
const OPENHAB="hal9000";//when not empty, read openHAB total value
const USE_DISK=true;//use disk for saving/loading state

//libraries
const serial = require("serialport");
const moment = require("moment");
const fs = require('fs');
const http = require('http');
const url = require('url');
const fetch = require('node-fetch');
//const digestFetch = require('digest-fetch');


//catch close server
process.on('SIGINT', function() {
  log("Nodejs stopped");
  process.exit();
});

//watermeter data (is also result of JSON webservice)
var active=0;//active bank (prevent inconsistant values over webservice)
var water=[];
water[0]={};
water[1]={};

var comState=0;//synchronisation state (0=none, 1=p0/p1 auto, 2=total auto, 3=p0/p1 manual, 4=total manual)
var waterTotal=0;//last water total in program
var waterTotalDisk=-1;//last water state on disk
var openHabWaterTotal=-1;//openHAB water state
var waterNewTotal=0;//new total (to send to arduino/openHAB)
var waterNewTotalSend=false;//done processing it
var myP0=-1;//current P0 (to detact changes)
var myP1=-1;//current P1 (to detect changes)


//fetch http settings
const settings = { method: "Get" };

//load state from file and openHAB
loadState();
getOpenHabItemState("water_meter_total", state => openHabWaterTotal=parseInt(0+1000*state));

/*########################
  # SERIAL COMMUNICATION #
  ######################## */


//connect to arduino watermeter USB
var serialPort = new serial("/dev/ttyUSB_WATER", {
  baudRate: 9600,
  databits: 8,
  parity: "none",
  stopbits: 1
});

serialPort.on("open", function() {

  console.log("Opened Arduino Serial port");
  var data = "";

  serialPort.on('data', function(buffer) {

    //serial receives stream of data, so this might be the next chunck or everything. You don't know when it's complete. That's why it needs a start/end 'sign'
    data += buffer;

    //erage EOL, not used
    data=data.replace('\r','').replace('\n','');
	
	  //a valid message starts with a '['. The routine keeps this at the start. So if it's not there, data corruption occured. Remove it.
    if (data!="" && data.indexOf('[')<0){
      //no start character at start. Incomplete message (usually due to startup of reading)
      data="";
      log('incomplete message erased');
    } else if (data.indexOf('[')>0){ 
      //start character not first. Incomplete message (usually due to startup of reading)
      data=data.substring(data.indexOf('['));
	    log('incomplete message erased');
    }

    //check for complete message between '[' and ']'
    if (data.indexOf('[') == 0 && data.indexOf(']') >= 0) {
      //complete message found 
      debug( 'message complete');
            
      //take data and remove it & keep remainder of stream
      let p=data.indexOf(']');
      let values=data.substring(1,p);
      data=data.substring(p+1);
      
      //process data
      var measurements=values.split(',');
      if (measurements.length>=12){
        //valid message with 12 args
        
        //init
        let wtr={};
        let raw={};

        //put total,p0,p1 in temp var (else the are send to openHAB which may be wrong
        raw.total=parseFloat(measurements[1]);
        if (wtr.calibration!='calibrating'){
          //not calibrating, Part-0 & Part-1 are given
          raw.p0=parseInt(measurements[9]);
          raw.p1=parseInt(measurements[10]);
        }else {
          raw.p0=0;
          raw.p1=0;
        }
        
        
        //check pending action calibration
        if (comState==1 && raw.p0==myP0){
          //received, done
          comState=0;
          debug('p0/p1 calibration processed');
        }
        
        //check pending action total
        
        if ((comState==2 && waterNewTotalSend && raw.total>=waterNewTotal) || (comState==4 && waterNewTotalSend && raw.total>=waterNewTotal && Math.abs(raw.total>=waterNewTotal)<20)){
          //new value processed by Arduino (new manual total might be smaller than current value, so extra check on 'close' !)

          //force constistant/update mem-values
          if (OPENHAB!=''){
            //openhab will change
            openHabWaterTotal=waterNewTotalSend;
          }
          if (USE_DISK){
            //set disk total with new value
            waterTotalDisk=waterNewTotalSend;
            
            if (raw.total>0 && raw.p0>0 && raw.p1>0){
              //update disk state
              saveState(raw.total,raw.p0,raw.p1);
            }
            
          }
          waterTotal=raw.total;

          //update complete, reset
          waterNewTotal=0;
          waterNewTotalSend=false;
          comState=0;
          debug('watermeter correction processed, values consistant');          
        }        
        
        //check reset/powerfail/disconnect issues
        let valid=true;
        if (waterNewTotal>0 || comState==2){
          //ongoing correction
          valid=false;
        } else if (raw.total<waterTotal && waterTotal>0){
          //current is less than last
          debug("inconsistant meter values detected (Raspberry)");
          valid=false;
        } else if (OPENHAB!='' && (raw.total<openHabWaterTotal || openHabWaterTotal<0)){
          //current is less than openHAB (or not yet known
          valid=false;
          debug("inconsistant meter values detected (openHAB)");
        } else if (USE_DISK && (raw.total<waterTotalDisk || waterTotalDisk<0)){
          valid=false;
          debug("inconsistant meter values detected (Disk backup)");
          //current is less than disk save (or not yet known)
        }
        wtr.valid=valid;//normal running mode or not
                 
        //put message/arduino readout in json object
        
        //'cpu' calculation
        let cycle=convertToIntegerValue(measurements[0]);
        let cpu=cycle/100;
        if (cpu>100){
          cpu=100;
        }
        wtr.loop=cycle;
        wtr.cpu=cpu;
        
        //water usage
        if (valid){
          wtr.total=raw.total;//only if valid
        }
        wtr.lastPeriod=parseFloat(measurements[2]);
        wtr.flow=convertToIntegerValue(measurements[3]);
        wtr.minTotal=parseFloat(measurements[4]);
        wtr.lastTotal=parseFloat(measurements[5]);
        wtr.pulse=parseInt(measurements[6]);
        wtr.lastTotalTime=parseFloat(measurements[7]);
        wtr.calibration=measurements[8];
        
        //depending on calibration state put them in p0/p1 or t0/t1
        if (wtr.calibration!='calibrating'){
          //not calibrating, Part-0 & Part-1 are given
          if (valid){
            wtr.p0=raw.p0;//only if valid
            wtr.p1=raw.p1;//only if valid
          }
        } else {
          //during calibration timings are given
          wtr.t0=parseInt(measurements[9]);
          wtr.t1=parseInt(measurements[10]);            
        }
        wtr.calCount=parseInt(measurements[11]);
      
        if (raw.total>=waterTotal){
          //new value Arduino watermeter is equal/higher than stored value, normal so keep it (if lower, arduino did reset)
          waterTotal=raw.total;
        }

        //check calibration
        if ( (comState==0 || comState==3) && valid && wtr.total>0 && wtr.calibration=='calibrated' && wtr.p0>0 && wtr.p1>0 && (wtr.p0!=myP0 || wtr.p1!=myP1)){
          //normal run or webinterface change: change in calibration, save
          log('calibration changed, updating');
          saveState(wtr.total,wtr.p0,wtr.p1);
          comState=1;
        } else if (comState==0 && AUTO_INIT && comState==0 && myP0>0 && myP0>0 & (wtr.calibration=='uncalibrated' || raw.p0==0 || raw.p1==0)){
          //auto init on and valid values
           sendCalibration(myP0,myP1);
           comState=1;
        }
        

        
        
        //check reboot/powerloss/upgrade/etc
        if (comState==0 && !valid && raw.total>=0 && (!USE_DISK || waterTotalDisk>=0) && (OPENHAB=='' || openHabWaterTotal>=0)){
          //no pending actions, current value is not valid and required data present
          
          debug('checking totals raspberry, arduino, disk, openHAB ('+raw.total+','+waterTotal+','+waterTotalDisk+' '+openHabWaterTotal+')');
          
          //best in memory value
          let highMem=Math.max(raw.total,waterTotal);
          
          //best disk totals
          let highDisk=Math.max(waterTotalDisk,openHabWaterTotal);
          if (highDisk<0){
            highDisk=0;
          }
          
          if (highDisk>highMem){
            //file/OH wins.
            waterNewTotal=highDisk;
            if (highMem<1000){
              //power reset could have been a while ago. No more than 1000 litres since that moment. Must be change since last save
              waterNewTotal+=highMem;
            }              
          }else if (waterTotal>raw.total){
            //raspberry higher than arduino, so arduino reset
            waterNewTotal=waterTotal;
            
            if (raw.total<1000){
              //power reset could have been a while ago. No more than 1000 litres since that moment. Must be change since last save
              waterNewTotal+=raw.total;
            }
          }          
        }
        
        
        
        if (waterNewTotal>0 && !waterNewTotalSend){
          //reset/powercycle/reboot/upgrade detected
          sendTotalWater(waterNewTotal);
          waterNewTotalSend=true;
          comState=2;
        }

          
        
        //processing done, siwtch active bank
        water[1-active]=wtr;
        active=1-active;
      }
    }
  });
});

//on serial error
serialPort.on("error", function(data) {
    log("@" + moment().format() + ": Error reading p1 port: " + data);
});

/*##############
  # WEB SERVER #
  ############## */

//create server 
const server = http.createServer((req, res) => {
  
  let data = '';

  //read data
  req.on('data', chunk => {
    //add chunk to total
    data += chunk;
  });

  //on completion
  req.on('end', () => {

    //get url and query
    const myUrl = url.parse(req.url,true);
    const path = lcase(myUrl.pathname);
    const query = myUrl.query;
    const bookmark = lcase(myUrl.hash);

    //split path in /command/parameter/value/ignore/ ...
    var command="";
    var parameter="";
    var value="";
    var i=path.indexOf('/',1);
    if (i<0){
        command=path;
    }else {
        var j=path.indexOf('/',i+1);
        command=path.substring(0,i);
        if (j<0){
            command=path.substring(0,i);
            parameter=path.substring(i+1);
        } else {
            parameter=path.substring(i+1,j);
            i=path.indexOf('/',j+1);
            if (i<0){
                value=path.substring(j+1);
            } else {
                value=path.substring(j+1,i);
            }
        }
    }
    value=value.toUpperCase();
    var parameterNr=parseInt(parameter);
    if (isNaN(parameterNr)){
      parameterNr=-1;
    }

    //debug output
    debug('------------');

    //check for json input
    var json={};
    try {
        json = JSON.parse(data);
    } catch (e){
    }
    
    if (DEBUG){
      let m='';
      if (path){
        m+='path:'+path;
      }
      if (command){
        m+=', command:'+command;
      }
      if (parameter){
        m+=', parameter: '+parameter;
      }
      if (value){
        m+=', value:'+value;
      }
      if (query && query.length>0){
        m+=', query:'+JSON.stringify(query);
      }
      if (bookmark){
        m+=', bookmark:'+bookmark;
      }
      if (data){
        m+=', data:'+data;
      }
      if (json && json.length>0){
        m+='json:'+JSON.stringify(json);
      }
      
      debug(m);
    }
    
    //default response
    var response="";

    //proces request and create response
    if (path=='/water'){
      response=JSON.stringify(water[active]);
    } else if (!water[active].valid){
      //no action, only in running mode
    } else if (command=='/total' && parameterNr>0){
      waterNewTotal=parameterNr;
      sendTotalWater(waterNewTotal);
      waterNewTotalSend=true;
      comState=4;
      response=parameter+" written";
    } else if (command=='/p0' && parameterNr>0){
      sendCalibration(parameterNr,10000-parameterNr);
      comState=3;
      response=parameterNr+" written";
    } else if (command=='/p1' && parameterNr>0){
      sendCalibration(10000-parameterNr,parameterNr);
      comState=3;
      response=parameterNr+" written";
    } else if (command=='/calibrate'){
      serialPort.write('CALIBRATE');
      comState=3;
      response="calibration started";
    } else if (command=='/calibration'){
      serialPort.write('CALIBRATION');
      response="calibration requested";
    }

    //send response
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain');
    res.end(response);
    debug('response '+response);
    debug('------------');

  });

});

//start server
server.listen(PORT, () => {
  log(`Server running on port ${PORT}.`);
});

/*########
  # FILE #
  ######## */

//save current state
function saveState(total,p0,p1){
    
    
  if (total>0 && p0>0 && p1>0){
  
    //execute in 3 seconds
    setTimeout(function(total,p0,p1){
      
      //write file
      fs.writeFile('watermeter.txt', parseInt(total)+','+parseInt(p0)+','+parseInt(p1), function (err) {
        if (err){
          log('failed writing state to disk');
        } else {
          log('saved state {total:'+total+',p0:'+p0+',p1:'+p1+'} to disk');
        }
      });

      myP0=p0;
      myP1=p1;
      
    },3000,total,p0,p1);
  }
}

function loadState(){
  
  
  fs.open('watermeter.txt', 'r+', function (err, fd) {
    if (err) {
      log('failed reading file');
      waterTotalDisk=0;
    }else {
      
      let buffer = new Buffer.alloc(64);
 
      fs.read(fd, buffer, 0, buffer.length,0, function (err, bytes) {
        if (err) {
          log('failed reading file');
          waterTotalDisk=0;
        }else if (bytes > 0) {
          let data = buffer.toString("utf8");
          data=data.split(',');
          waterTotalDisk=convertToIntegerValue(data[0]);
          if (data.length>2){
            //p0,p1 included
            myP0=convertToIntegerValue(data[1]);
            myP1=convertToIntegerValue(data[2]);
            
          }
        }
       
        // Close the opened file.
        fs.close(fd, function (err) {});
      });
    }
  });
    
  //check for hard init?
  if ((myP0<=0 || myP1<=0) && MY_P0>0 && MY_P1>0){
    //invalid and hardcoded presets
    myP0=MY_P0;
    myP1=MY_P1;
  }  
}

function getOpenHabItem(item){
  
  //http://hal9000:8080/rest/items/water_meter_total
  //http://hal9000:8080/rest/items/water_meter_total/state
  
  
  //2 minute before for now (depending on update frequency too short period gives no result)
  
  
  let old=new Date();
  old=new Date(old.getTime()-120000);
  old=old.toISOString();

  //create rest api url
  let url="http://"+OPENHAB+":8080/rest/persistence/items/"+item+"?starttime="+old;
  debug(url);
 
  fetch(url, settings)
    .then(resp=>resp.json())
    .then(data=>{
      //proces incoming json inverter data
      
      //should have a series of datapoints, take last one
      if (data.datapoints>=1){
        let points=1*data.datapoints-1;
        let value=data.data[points].state;
        debug('reading openHAB '+item+' as '+value);
      }else {
        log('error reading openHAB '+item);
      }
      
    })
    .catch(e=>log(e));


  let url1="http://hal9000:8080/rest/items/water_meter_total/state";
  debug(url1);
 
  fetch(url1, settings)
    .then(resp=>resp.text())
    .then(data=>{
      //proces incoming json inverter data
      
      
      
      debug(JSON.stringify(data));
      
      
    })
    .catch(e=>log(e));


  
}


function getOpenHabItemState(item, callback){
  

  let url="http://"+OPENHAB+":8080/rest/items/"+item+"/state";
 
  fetch(url, settings)
    .then(resp=>resp.text())
    .then(data=>{
      //proces incoming state
      if (!data || data=="NULL"){
        data="";
      }
      let p=data.indexOf(' ');
      if (p>=0){
        data=data.substring(0,p);
      }

      debug('reading openHAB '+item+' as '+data);
      
      callback(data);
      
    })
    .catch(e=>log(e));
  
}


/*####################
  # HELPER FUNCTIONS #
  #################### */


//send P0 & P1 calibration to arduino watermeter
function sendCalibration(p0,p1){
  
  if (p0>0 && p1>0){
    
    log('updating arduino calibration '+p0+', '+p1);
  
    //execute in 3 seconds
    setTimeout(function(p0,p1){

      serialPort.write('P0:'+p0);//will also set (remainder) P1
      
    },3000,p0,p1);
  }



}


function sendTotalWater(total){

  if (total && 1*total>0){
    total=1.0*total;
  } else {
    total=0;
  }

  if (total>0){
    //reset/powercycle/reboot/upgrade detected
    log("Updating arduino total "+total);
    
    //send it in 3 seconds
    setTimeout(function(w){
      serialPort.write('T:'+w);
    },3000,total);
  }
}


//get string between given chars (when not found from first and/or to last)
function getStringBetween(data, charLeft, charRight) {
  
  //look for left char
  let i = data.indexOf(charLeft);
  if (i < 0) {
      i = 0;
  } else {
      i++;
  }
  
  //look for right char
  let j = data.indexOf(charRight);
  if (j < 0) {
      j = data.length;
  }

  let result = data.substring(i, j);
  if (result.endsWith(')')) {
      result = result.substring(0, result.length - 1);
  }

  return result;
}

//return int value (removing thousand sign)
function convertToIntegerValue(value) {
  return parseInt(value.replace(/\./, ''), 10);
}


//null-safe lowercase
function lcase(x) {
    if (x == null){
        return "";
    } else {
        return x.toLowerCase();
    }
}

//log (always)
function log(msg){
  console.log(msg);
}

//log debug info when on
function debug(msg){
  if (DEBUG){
      console.debug(msg);
  }
}
