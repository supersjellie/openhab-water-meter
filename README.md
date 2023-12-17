# openHAB-water-meter (pulse sensor)

## Summary
Setup for using a watermeter in openHAB using a pulsecounter constructed with a Hall-effect proximity sensor. It's made with a few components (can be used independant). A Arduino sketch for the pulsecounting posting results over a serial USB connection. A nodeJS progam that reads this and creates an JSON webservice that openHAB can use. Last a thing and widget to make this easier.

![example 1](images-wiki/watermeter.png?raw=true)

Features
1. http://hostname:3002/water 
	* Water meter readings in JSON format of total, current flow, last useage and other statistics
2. http://hostname:3002/total/number
	* Set total water in liters, so 2345 = 2,345 m3.
3. http://hostname3002/p0/number 
	* Set P0 calibration (0-10000). Will set P1 to 10000-P0.
4. http://hostname3002/p1/number 
	* Set P1 calibration (0-10000). Will set P0 to 10000-P1.
5. http://hostname3002/calibrate 
	* Perform (new) calibration of sensor. Make sure a steady waterflow is present.
6. When set the calibration and total will be kept if system reboots (by using hard drive and/or openHAB)
  
## Worklist
Using the [releases](https://github.com/Supersjellie/openhab-water-meter/releases) in github now
Using the [issues](https://github.com/Supersjellie/openhab-water-meter/issues) in github now
(I'm not using branches for work in progress (i.e. latest milestone), so download a release for a stable version)

https://www-netsjel-nl.translate.goog/watermeter-1.html?_x_tr_sl=nl&_x_tr_tl=en&_x_tr_hl=nl&_x_tr_pto=wapp

## Preperation
1. Have an openhab installation :grin:
2. Own a water meter with magnetic wheel :grin:
3. Buy and create arduino hardware for pulse counting (check more information link below).
4. Install [nodeJS](https://nodejs.org/en) on your raspberry.
5. Adapt configuration to your needs (top of NodeJS code).
4. Install in openhab the http binding, see [documentation](https://www.openhab.org/addons/bindings/http/)
6. Install in openhab the jsonpath transformation, see [documentation](https://www.openhab.org/addons/transformations/jsonpath/)
7. Install in openHAB the javascript scriping engine, see [documentation](https://www.openhab.org/addons/automation/jsscripting/)

More information, check my dutch [homepage](https://www.netsjel.nl/watermeter-1.html). English? [Google Translate](https://www-netsjel-nl.translate.goog/watermeter-1.html?_x_tr_sl=nl&_x_tr_tl=en&_x_tr_hl=nl&_x_tr_pto=wapp) will be your friend.

## Deploy nodeJS progam
1. Assuming you're familair with nodeJS. Copy the water.js program to your program folder.
2. Change the configurion (top of code) to your need.
3. USE_DISK will save calibration and total to disk (to keep values on startup/powerloss). File will be watermeter.txt.
4. OPENHAB (your openHAB server name) will load openHAB total value on startup/powerloss)
5. PORT is the portnumber the service will use.
6. Add it to PM2 programs to run and restart at startup (PM2 start water.js)
7. If you're new to nodeJS. Check the link in preparation to install it. Also install PM2 and check how it is used. A brief summary can also be found on my [website](https://www.netsjel.nl/watermeter-1.html). English? [Google Translation](https://www-netsjel-nl.translate.goog/watermeter-1.html?_x_tr_sl=nl&_x_tr_tl=en&_x_tr_hl=nl&_x_tr_pto=wapp)
8. If succesfull http://hostname:3002/water will show a JSON string.
9. The program has an option to double the accurancy. Place the sensor half on the wheel and calibrate it. Check website above.

## Create thing
1. Create a new thing
2. Choose the HTTP binding
3. Don't use GUI but move to tab code
4. Copy and paste the yaml in the thing folder of this project
5. Save the thing 
6. Don't close it

## Create equipment
1. If it's closed, navigate to your smart_meter thing
2. Move to the tab 'channels'
3. Use button 'Add equipment to model
4. Select all channels and add-on
5. Openhab will create/add equipment and items

## Widget installation
1. The widget needs 4 images. Copy the images in the github images folder to the html folder in your openHAB configuration.
1. Add a new widget
2. Remove default code
3. Copy and past the yaml in the widget code of this project and save

## Widget usage/configuration
1. Add a new widget to your dashboard/page
2. Select water_meter from the custom widgets
3. Set the props (minimal is the item) and save

## Versions
* V1.0 - Initial release on github
	
## Code
The code is pretty standard if you're familair with nodeJS. Know that I have plans, that's why some code has no use at this moment.