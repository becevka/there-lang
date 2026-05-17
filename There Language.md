## Main syntax formula

 ```generator processor (collector) (parameters) (=> reducer);```

#### Example 1

 ```there is apple;```

 **there** - is a a by type generator which initializes environment for which processor will process collected parameters
 
 **is**  - is a processor which process what was collected on the environment
 
 **apple** - is simple parameter, automatically collected, collector is omitted
 
 **reducer** is omitted in this case as well

#### Example 2

```(apple) {age add $years} ($years:number) => makeOlder;```

 **(apple)** - is a a by word generator which will be used to check environment for which processor will process collected parameters
 
 **{age add $years}**  - is a definition of processor which process what was collected on the environment
 
 **($years:number)** - is parameters collector which defines type of parameter, parameter is omitted, processor is not run
 
 **=> makeOlder** -  reducer which will store processor under name makeOlder

 Effectively, now we can call it

 ```
 there is apple;
 apple has age;
 apple age is 0;
 apple makeOlder 12;
 apple age => $print;
 apple makeOlder "12"; #will not be called
 ```

#### Example 3

 ```(apple) {age add $years} (for $years:number years) => grew;```

 **(for $years:number)** - is parameters collector which defines type of parameter an also specifies extra word which will be parsed but not taken into account

 Effectively, now we can say

 ```
 apple grew for 12 years;
 apple grew 12 years; #will not be called
 ```

 ```(apple) {age add $years} ([for|] $years:number years) => grew;```

 using simple regex we can make some words optional, so now
 `apple grew 12 years;`will work

```(apple) {age add $years} ([for|] $years:?number [years|]) => grew;```

 using **?** with type we can make parameter optional, so now `apple grew;` will work but apple age will be not changed because calling ```add ?``` skips modification




## Types

 **element** - is the most basic type, it is abstract and it does not available by itself, we can say that spaces between words or semicolon are elements, but it is better to name them punctuations or syntactical elements
 
 **word** - is the very popular thing, actually it is named element, when we say `apple;` we use word **apple** to generate access to apple type
 
 **metatype** - is word with type of itself, when we say `apple;` we actually turn word **apple** into metatype apple. 
 Compare `apple is green` and `(apple) is green`, in the first case we access metatype apple and in second we create generator
 
 **value** - is metatype with value property. For example, `12` is number metatype with value 12. If we specify `12 => a`. There is difference between **12** and **a**, since **12** is value, but **a** is metatype, actually it is an object, but we will get to it later
 
 **number** - is value with numeric value property, defined using integer or decimal numbers, eg. `12, 13.4`

 **string** - is value with string value property, defined using text in single or double quotes, eg. `"this is string", 'this is also string'`
 
 **block**
 
 
 
 
 
 
 
 
 
 
 
 
