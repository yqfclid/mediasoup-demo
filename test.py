#!/bin/python 
import urllib
import urllib2
import json

port1f = urllib.urlopen("http://127.0.0.1:5001/createpipe1")
port1 = port1f.read()
port2f = urllib.urlopen("http://127.0.0.1:5000/createpipe2")
port2 = port2f.read()

urllib.urlopen("http://127.0.0.1:5001/startconnect1?pipeport=" + port2)
urllib.urlopen("http://127.0.0.1:5000/startconnect2?pipeport=" + port1)

rr = urllib.urlopen("http://127.0.0.1:5001/consume")
rrp = rr.read()
print rrp

req = urllib2.Request(url="http://127.0.0.1:5000/produce", data=rrp, headers={'Content-Type':'application/json'})


res = urllib2.urlopen(req)
res = res.read()
print(res)
